/** Resumable single-file SFTP transfers for Direct SSH. Each direction keeps a deterministic
 * `.part` file plus a tiny sidecar that records the far side's size/mtime (downloads) or the
 * local source's identity (uploads); a retried transfer appends from the surviving offset when
 * both sides still match, and restarts from zero otherwise, so a changed file can never resume
 * into corrupted output. */
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'
import { sftpStat } from './direct-ssh-sftp-ops'
import { waitForSftpCallback } from '../../providers/ssh-filesystem-provider-sftp'

export type TransferProgress = (transferred: number, total: number) => void

type DownloadResume = { remoteSize: number; remoteMtime: number }

export async function resumeSftpDownload(
  sftp: SFTPWrapper,
  remotePath: string,
  tempPath: string,
  options: { signal: AbortSignal; onProgress: TransferProgress }
): Promise<void> {
  const remote = await sftpStat(sftp, remotePath)
  const offset = await prepareDownloadResume(tempPath, remote.size, remote.mtime)
  let counted = 0
  const read = sftp.createReadStream(remotePath, { start: offset })
  read.on('data', (chunk: string | Buffer) => {
    counted += chunk.length
    options.onProgress(offset + counted, remote.size)
  })
  await pipeline(read, createWriteStream(tempPath, { flags: offset > 0 ? 'a' : 'w' }), {
    signal: options.signal
  })
  const landed = await stat(tempPath)
  if (landed.size !== remote.size) {
    throw new Error('The download is incomplete and will resume from where it stopped.')
  }
  // A file rewritten mid-transfer must not land under the recorded identity.
  const fresh = await sftpStat(sftp, remotePath)
  if (fresh.size !== remote.size || fresh.mtime !== remote.mtime) {
    throw new Error('The remote file changed during the transfer; retry to fetch the new version.')
  }
}

async function prepareDownloadResume(
  tempPath: string,
  remoteSize: number,
  remoteMtime: number
): Promise<number> {
  const metaPath = `${tempPath}.meta`
  let offset = 0
  try {
    const existing: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
    if (
      isDownloadResume(existing) &&
      existing.remoteSize === remoteSize &&
      existing.remoteMtime === remoteMtime &&
      (await stat(tempPath)).size <= remoteSize
    ) {
      offset = (await stat(tempPath)).size
    }
  } catch {
    offset = 0
  }
  await writeFile(metaPath, JSON.stringify({ remoteSize, remoteMtime } satisfies DownloadResume))
  if (offset === 0) {
    await truncate(tempPath, 0).catch(() => {})
  }
  return offset
}

function isDownloadResume(value: unknown): value is DownloadResume {
  return (
    typeof value === 'object' &&
    value !== null &&
    'remoteSize' in value &&
    typeof value.remoteSize === 'number' &&
    Number.isFinite(value.remoteSize) &&
    'remoteMtime' in value &&
    typeof value.remoteMtime === 'number' &&
    Number.isFinite(value.remoteMtime)
  )
}

/** Removes the temp artifacts once the download reached its destination. */
export async function cleanupDownloadArtifacts(tempPath: string): Promise<void> {
  await unlink(`${tempPath}.meta`).catch(() => {})
  await unlink(tempPath).catch(() => {})
}

type UploadResume = { size: number; mtimeMs: number; dev: number; ino: number }

export async function resumeSftpUpload(
  sftp: SFTPWrapper,
  localPath: string,
  tempPath: string,
  options: { signal: AbortSignal; onProgress: TransferProgress }
): Promise<void> {
  const local = await stat(localPath)
  const identity: UploadResume = {
    size: local.size,
    mtimeMs: local.mtimeMs,
    dev: local.dev,
    ino: local.ino
  }
  const offset = await prepareUploadResume(sftp, tempPath, identity)
  let counted = 0
  const read = createReadStream(localPath, { start: offset })
  read.on('data', (chunk: string | Buffer) => {
    counted += chunk.length
    options.onProgress(offset + counted, local.size)
  })
  await pipeline(
    read,
    sftp.createWriteStream(
      tempPath,
      offset > 0 ? { flags: 'r+' as const, start: offset } : { flags: 'w' as const }
    ),
    { signal: options.signal }
  )
  const landed = await sftpStat(sftp, tempPath)
  if (landed.size !== local.size) {
    throw new Error('The upload is incomplete and will resume from where it stopped.')
  }
  const fresh = await stat(localPath)
  if (fresh.mtimeMs !== identity.mtimeMs || fresh.size !== identity.size) {
    throw new Error('The local file changed during the upload; retry to send the new version.')
  }
}

async function prepareUploadResume(
  sftp: SFTPWrapper,
  tempPath: string,
  identity: UploadResume
): Promise<number> {
  let offset = 0
  try {
    const existing: unknown = JSON.parse(await sftpReadFile(sftp, `${tempPath}.meta`))
    if (
      isUploadResume(existing) &&
      existing.size === identity.size &&
      existing.mtimeMs === identity.mtimeMs &&
      existing.dev === identity.dev &&
      existing.ino === identity.ino
    ) {
      offset = (await sftpStat(sftp, tempPath)).size
      if (offset > identity.size) {
        offset = 0
      }
    }
  } catch {
    offset = 0
  }
  await sftpWriteFile(sftp, `${tempPath}.meta`, JSON.stringify(identity))
  return offset
}

function isUploadResume(value: unknown): value is UploadResume {
  return (
    typeof value === 'object' &&
    value !== null &&
    'size' in value &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    'mtimeMs' in value &&
    typeof value.mtimeMs === 'number' &&
    Number.isFinite(value.mtimeMs) &&
    'dev' in value &&
    typeof value.dev === 'number' &&
    Number.isFinite(value.dev) &&
    'ino' in value &&
    typeof value.ino === 'number' &&
    Number.isFinite(value.ino)
  )
}

/** Promotes a finished upload temp over the destination atomically when the server supports the
 * OpenSSH extension; otherwise falls back to unlink+rename. */
export async function promoteUploadTemp(
  sftp: SFTPWrapper,
  tempPath: string,
  destination: string
): Promise<void> {
  const renamed = await new Promise<boolean>((resolve) => {
    try {
      sftp.ext_openssh_rename(tempPath, destination, (error) => resolve(!error))
    } catch {
      resolve(false)
    }
  })
  if (!renamed) {
    await waitForSftpCallback((callback) => sftp.unlink(destination, callback)).catch(() => {})
    await waitForSftpCallback((callback) => sftp.rename(tempPath, destination, callback))
  }
  await waitForSftpCallback((callback) => sftp.unlink(`${tempPath}.meta`, callback)).catch(() => {})
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<string> {
  return waitForSftpCallback(
    (callback) =>
      sftp.readFile(path, (error?: Error, handle?: Buffer) =>
        callback(error, handle?.toString('utf8'))
      ),
    {}
  )
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, contents: string): Promise<void> {
  return waitForSftpCallback((callback) => sftp.writeFile(path, contents, callback), {})
}
