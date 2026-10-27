/** Direct SSH file explorer backend: browse over the host's SFTP while every native picker,
 * temp path and atomic promotion stays in main. Browsing is POSIX-host only — Windows OpenSSH
 * serves SFTP with drive-letter paths the POSIX walker and upload verification do not honor. */
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import type {
  DirectSshBrowseResult,
  DirectSshFileEntry,
  DirectSshTransferStartResult
} from '../../../shared/direct-ssh-files'
import { sortDirEntries } from '../../../shared/file-name-sort'
import { sftpEndQuietly, sftpRealpath, sftpReaddir, sftpStat } from './direct-ssh-sftp-ops'
import { isValidRemoteEntryName, joinSftpChildPath } from './direct-ssh-folder-download'
import {
  DirectSshTransferRunner,
  errorMessage,
  type DirectSshFileConnection,
  type DirectSshTransferRunnerDeps,
  type TransferGuard,
  type TransferSink
} from './direct-ssh-transfer-runner'

export type { DirectSshFileConnection } from './direct-ssh-transfer-runner'

export type DirectSshFileServiceDeps = DirectSshTransferRunnerDeps
const POSIX_UNAMES = new Set(['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd'])

// Why uname: Windows OpenSSH serves SFTP with drive-letter paths the POSIX walker joins and
// uploadFile's source verification do not honor; Direct file browsing is POSIX-host only.
const NON_POSIX_MESSAGE =
  'File browsing currently supports Linux and macOS SSH hosts only. Windows SSH hosts are not supported yet.'

export class DirectSshFileService {
  private readonly posixVerdicts = new Map<string, { generation: number; posix: boolean }>()
  private readonly runner: DirectSshTransferRunner

  constructor(private readonly deps: DirectSshFileServiceDeps) {
    this.runner = new DirectSshTransferRunner(deps)
  }

  async home(targetId: string): Promise<DirectSshBrowseResult> {
    return this.withBrowseSession(targetId, async (sftp) => ({
      ok: true,
      path: await sftpRealpath(sftp, '.'),
      entries: []
    }))
  }

  async list(targetId: string, dir: string): Promise<DirectSshBrowseResult> {
    return this.withBrowseSession(targetId, async (sftp) => {
      // SFTP servers don't expand '~'; home is what the caller means by it.
      const requested = dir === '' || dir === '~' ? '.' : dir
      const resolved = await sftpRealpath(sftp, requested)
      const raw = await sftpReaddir(sftp, resolved)
      const decorated = raw
        .filter((entry) => isValidRemoteEntryName(entry.filename))
        .map((entry) => {
          const kind: DirectSshFileEntry['kind'] = entry.attrs.isSymbolicLink()
            ? 'symlink'
            : entry.attrs.isDirectory()
              ? 'directory'
              : entry.attrs.isFile()
                ? 'file'
                : 'other'
          return {
            name: entry.filename,
            isDirectory: kind === 'directory',
            entry: {
              name: entry.filename,
              path: joinSftpChildPath(resolved, entry.filename),
              kind,
              size: kind === 'file' ? entry.attrs.size : null,
              modifiedMs: typeof entry.attrs.mtime === 'number' ? entry.attrs.mtime * 1000 : null
            } satisfies DirectSshFileEntry
          }
        })
      sortDirEntries(decorated)
      return { ok: true, path: resolved, entries: decorated.map((item) => item.entry) }
    })
  }

  async startDownload(
    targetId: string,
    remotePath: string,
    sink: TransferSink
  ): Promise<DirectSshTransferStartResult> {
    const guard = await this.guardTransfer(targetId)
    if (!guard.ok) {
      return guard
    }
    let sftp: SFTPWrapper | null = null
    try {
      sftp = await guard.connection.sftp()
      const stats = await sftpStat(sftp, remotePath)
      sftpEndQuietly(sftp)
      sftp = null
      return stats.isDirectory()
        ? this.runner.startFolderDownload(targetId, remotePath, sink)
        : this.runner.startFileDownload(targetId, remotePath, sink)
    } catch (error) {
      if (sftp) {
        sftpEndQuietly(sftp)
      }
      return { ok: false, message: errorMessage(error) }
    }
  }

  async startUpload(
    targetId: string,
    remoteDir: string,
    sink: TransferSink
  ): Promise<DirectSshTransferStartResult> {
    if (!remoteDir.trim()) {
      return { ok: false, message: 'Upload destination is required' }
    }
    const guard = await this.guardTransfer(targetId)
    if (!guard.ok) {
      return guard
    }
    return this.runner.startUpload(targetId, remoteDir, sink)
  }

  cancel(transferId: string): void {
    this.runner.cancel(transferId)
  }

  /** Teardown (disconnect, removal): abort every transfer so nothing outlives its transport. */
  cancelForTarget(targetId: string): void {
    this.runner.cancelForTarget(targetId)
  }

  cancelAll(): void {
    this.runner.cancelAll()
  }

  private async withBrowseSession(
    targetId: string,
    browse: (sftp: SFTPWrapper) => Promise<DirectSshBrowseResult>
  ): Promise<DirectSshBrowseResult> {
    const guard = this.guardConnection(targetId)
    if (!guard.ok) {
      return guard
    }
    if (!(await this.isPosixRemote(targetId, guard.connection))) {
      return { ok: false, message: NON_POSIX_MESSAGE }
    }
    let sftp: SFTPWrapper | null = null
    try {
      sftp = await guard.connection.sftp()
      return await browse(sftp)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    } finally {
      if (sftp) {
        sftpEndQuietly(sftp)
      }
    }
  }

  private guardConnection(targetId: string): TransferGuard {
    const connection = this.deps.getConnection(targetId)
    if (!connection || connection.isDisposed()) {
      return { ok: false, message: 'The host is not connected. Connect it first.' }
    }
    if (connection.getState().status !== 'connected') {
      return { ok: false, message: 'The host is reconnecting. Try again once it is online.' }
    }
    return { ok: true, connection, target: connection.getTarget() }
  }

  private async guardTransfer(targetId: string): Promise<TransferGuard> {
    if (this.runner.isAtCapacity()) {
      return { ok: false, message: 'Too many transfers are running. Wait for one to finish.' }
    }
    const guard = this.guardConnection(targetId)
    if (!guard.ok) {
      return guard
    }
    if (!(await this.isPosixRemote(targetId, guard.connection))) {
      return { ok: false, message: NON_POSIX_MESSAGE }
    }
    return guard
  }

  private async isPosixRemote(
    targetId: string,
    connection: DirectSshFileConnection
  ): Promise<boolean> {
    const generation = connection.getConnectGeneration()
    const cached = this.posixVerdicts.get(targetId)
    if (cached && cached.generation === generation) {
      return cached.posix
    }
    const posix = await probePosixRemote(connection)
    this.posixVerdicts.set(targetId, { generation, posix })
    return posix
  }
}

async function probePosixRemote(connection: DirectSshFileConnection): Promise<boolean> {
  try {
    const channel = await connection.exec('uname -s')
    const output = await readChannelOutput(channel)
    const uname = output.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    return POSIX_UNAMES.has(uname)
  } catch {
    return false
  }
}

function readChannelOutput(channel: ClientChannel): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      channel.close()
      reject(new Error('The remote platform probe timed out'))
    }, 10_000)
    timer.unref?.()
    channel.on('data', (chunk: Buffer) => {
      if (output.length < 4096) {
        output += chunk.toString('utf8')
      }
    })
    channel.on('exit', () => resolve(output))
    channel.on('close', () => resolve(output))
    channel.on('error', (error: Error) => reject(error))
  })
}
