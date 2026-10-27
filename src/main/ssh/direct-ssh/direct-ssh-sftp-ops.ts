/** Thin SFTP request wrappers for Direct SSH browsing and transfers: each op is one bounded
 * round trip on the caller's own SFTP session. */
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import { waitForSftpCallback } from '../../providers/ssh-filesystem-provider-sftp'

/** A silent transport must not hang a browse or transfer forever. */
const REQUEST_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The SSH file request timed out')),
      REQUEST_TIMEOUT_MS
    )
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return withTimeout(waitForSftpCallback((cb) => sftp.realpath(path, cb)))
}

export function sftpReaddir(
  sftp: SFTPWrapper,
  path: string,
  options?: { signal?: AbortSignal }
): Promise<FileEntryWithStats[]> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh2's readdir callback is structurally compatible; its declared type is narrower than the runtime contract.
  return withTimeout(waitForSftpCallback((cb) => sftp.readdir(path, cb as never), options))
}

export function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return withTimeout(waitForSftpCallback((cb) => sftp.stat(path, cb)))
}

export function sftpFastGet(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  return withTimeout(waitForSftpCallback((cb) => sftp.fastGet(remotePath, localPath, cb), options))
}

export function sftpEndQuietly(sftp: SFTPWrapper): void {
  try {
    sftp.end()
  } catch {
    // Cleanup is best-effort; a dead channel has nothing left to release.
  }
}
