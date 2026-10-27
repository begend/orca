/** Direct SSH file explorer's IPC contract: browse and transfer on one manually-added host.
 * Main owns every native picker, temp path and atomic promotion; the renderer only names
 * remote paths. */
export const DIRECT_SSH_FILE_CHANNELS = {
  home: 'directSsh:homeDir',
  list: 'directSsh:listDir',
  download: 'directSsh:download',
  upload: 'directSsh:upload',
  cancel: 'directSsh:cancelTransfer',
  event: 'directSsh:transferEvent'
} as const

export type DirectSshFileEntry = {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number | null
  modifiedMs: number | null
  symlinkTarget?: string
}

export type DirectSshBrowseResult =
  | { ok: true; path: string; entries: DirectSshFileEntry[] }
  | { ok: false; message: string }

export type DirectSshTransferStartResult =
  | { ok: true; transferId: string }
  | { ok: false; cancelled?: boolean; message: string }

export type DirectSshTransferEvent =
  | {
      kind: 'progress'
      transferId: string
      label: string
      transferred: number
      total: number | null
    }
  | { kind: 'done'; transferId: string; label: string; skipped: number }
  | { kind: 'error'; transferId: string; label: string; message: string }
  | { kind: 'cancelled'; transferId: string; label: string }
