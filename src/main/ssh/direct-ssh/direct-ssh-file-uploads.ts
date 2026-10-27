/** Upload execution for Direct SSH: picks up the runner-claimed batch, uploads each item over a
 * shared SFTP session, and reports item-count progress for batches and byte progress for single
 * files. A batch stops at the first failing item so partial results are always reported. */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { uploadDirectory } from '../sftp-upload'
import { promoteUploadTemp, resumeSftpUpload } from './direct-ssh-resumable-transfer'
import { sftpEndQuietly } from './direct-ssh-sftp-ops'
import type { ActiveTransfer, TransferHost } from './direct-ssh-transfer-runner'

export async function runUploadItems(
  host: TransferHost,
  transfer: ActiveTransfer,
  remoteDir: string,
  localPaths: string[]
): Promise<void> {
  const connection = host.deps.getConnection(transfer.targetId)
  if (!connection) {
    host.fail(transfer, 'The host is not connected.')
    return
  }
  const baseDir = `${remoteDir.replace(/\/+$/g, '')}`
  let sftp: SFTPWrapper | null = null
  let done = 0
  // A single file gets byte progress; batches count items.
  const byteProgress = localPaths.length === 1
  const claimed: string[] = []
  try {
    sftp = await connection.sftp()
    for (const localPath of localPaths) {
      transfer.controller.signal.throwIfAborted()
      const name = basename(localPath)
      const remotePath = `${baseDir}/${name}`
      const tempPath = `${baseDir}/.orca-upload-${name}.part`
      if (!host.claimUploadTemp(tempPath)) {
        throw new Error(`'${name}' is already being uploaded to this folder.`)
      }
      claimed.push(tempPath)
      await uploadOne(sftp, host, transfer, localPath, remotePath, tempPath, byteProgress)
      done += 1
      if (!byteProgress) {
        host.emitProgress(transfer, done, localPaths.length)
      }
    }
    transfer.sink({ kind: 'done', transferId: transfer.id, label: transfer.label, skipped: 0 })
  } catch (error) {
    host.failOrCancel(transfer, error)
  } finally {
    for (const tempPath of claimed) {
      host.releaseUploadTemp(tempPath)
    }
    if (sftp) {
      sftpEndQuietly(sftp)
    }
    host.endTransfer(transfer)
  }
}

async function uploadOne(
  sftp: SFTPWrapper,
  host: TransferHost,
  transfer: ActiveTransfer,
  localPath: string,
  remotePath: string,
  tempPath: string,
  byteProgress: boolean
): Promise<void> {
  const stats = await stat(localPath)
  if (stats.isDirectory()) {
    await uploadDirectory(sftp, localPath, remotePath, localPath, {
      signal: transfer.controller.signal
    })
    return
  }
  await resumeSftpUpload(sftp, localPath, tempPath, {
    signal: transfer.controller.signal,
    onProgress: byteProgress
      ? (transferred, total) => host.emitProgress(transfer, transferred, total)
      : () => {}
  })
  await promoteUploadTemp(sftp, tempPath, remotePath)
}
