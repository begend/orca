/** Bounded recursive folder download for Direct SSH: walks the remote tree with per-entry name
 * validation, refuses symlinks and special files, and reserves each local name exclusively so
 * a hostile tree cannot escape the chosen destination or overwrite case/Unicode twins. */
import { mkdir, open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { sftpFastGet, sftpReaddir } from './direct-ssh-sftp-ops'

export const TRANSFER_BUDGET = {
  maxEntries: 50_000,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxDepth: 64
} as const

export function isValidRemoteEntryName(name: string): boolean {
  return (
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  )
}

export function joinSftpChildPath(dir: string, childName: string): string {
  if (!isValidRemoteEntryName(childName)) {
    throw new Error(`Invalid remote directory entry '${childName}'`)
  }
  return `${dir.replace(/\/+$/g, '')}/${childName}`
}

/** Deterministic per destination, so a retried download finds its resumable temp. */
export function downloadTempPath(destination: string): string {
  return join(dirname(destination), `.orca-download-${basename(destination)}.part`)
}

export class FolderDownloadWalker {
  skipped = 0
  private entriesSeen = 0
  private bytesDone = 0
  private bytesTotal = 0

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly signal: AbortSignal,
    private readonly onProgress: (bytesDone: number, bytesTotal: number) => void
  ) {}

  async downloadTree(remoteDir: string, localDir: string, depth: number): Promise<void> {
    if (depth > TRANSFER_BUDGET.maxDepth) {
      throw new Error(`The folder is nested deeper than ${TRANSFER_BUDGET.maxDepth} levels.`)
    }
    this.signal.throwIfAborted()
    const raw = await sftpReaddir(this.sftp, remoteDir, { signal: this.signal })
    for (const entry of raw) {
      if (entry.filename === '.' || entry.filename === '..') {
        continue
      }
      if (!isValidRemoteEntryName(entry.filename) || entry.attrs.isSymbolicLink()) {
        this.skipped += 1
        continue
      }
      this.entriesSeen += 1
      if (this.entriesSeen > TRANSFER_BUDGET.maxEntries) {
        throw new Error(`The folder holds more than ${TRANSFER_BUDGET.maxEntries} entries.`)
      }
      if (entry.attrs.isDirectory()) {
        const childLocal = join(localDir, entry.filename)
        await mkdir(childLocal, { recursive: true })
        await this.downloadTree(joinSftpChildPath(remoteDir, entry.filename), childLocal, depth + 1)
        continue
      }
      if (!entry.attrs.isFile()) {
        this.skipped += 1
        continue
      }
      await this.downloadFile(remoteDir, localDir, entry.filename, entry.attrs.size)
    }
  }

  private async downloadFile(
    remoteDir: string,
    localDir: string,
    name: string,
    size: number
  ): Promise<void> {
    this.signal.throwIfAborted()
    const localPath = join(localDir, name)
    try {
      // Reserving with 'wx' turns later case/Unicode twins of this name into skips, not overwrites.
      const reserve = await open(localPath, 'wx')
      await reserve.close()
    } catch {
      this.skipped += 1
      return
    }
    this.bytesTotal += Math.max(0, size)
    if (this.bytesTotal > TRANSFER_BUDGET.maxTotalBytes) {
      throw new Error('The folder exceeds the 4 GiB download limit.')
    }
    await sftpFastGet(this.sftp, joinSftpChildPath(remoteDir, name), localPath, {
      signal: this.signal
    })
    this.bytesDone += Math.max(0, size)
    this.onProgress(this.bytesDone, this.bytesTotal)
  }
}
