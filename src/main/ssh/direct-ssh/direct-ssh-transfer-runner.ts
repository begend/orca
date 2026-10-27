/** Direct SSH transfer runner: owns active transfers, native pickers, per-destination/temp
 * concurrency guards, progress throttling and the atomic temp-to-destination promotion. */
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import type {
  DirectSshTransferEvent,
  DirectSshTransferStartResult
} from '../../../shared/direct-ssh-files'
import { sanitizeLocalDownloadFilename } from '../../local-download-filename'
import { sftpEndQuietly } from './direct-ssh-sftp-ops'
import { cleanupDownloadArtifacts, resumeSftpDownload } from './direct-ssh-resumable-transfer'
import { downloadTempPath, FolderDownloadWalker } from './direct-ssh-folder-download'
import { runUploadItems } from './direct-ssh-file-uploads'

/** Structural slice of SshConnection the file service needs. */
export type DirectSshFileConnection = {
  getTarget(): SshTarget
  exec(command: string): Promise<ClientChannel>
  sftp(): Promise<SFTPWrapper>
  getState(): { status: string }
  isDisposed(): boolean
  getConnectGeneration(): number
}

export type DirectSshTransferRunnerDeps = {
  getConnection: (targetId: string) => DirectSshFileConnection | undefined
  getMainWindow: () => BrowserWindow | null
}

export type TransferGuard =
  | { ok: true; connection: DirectSshFileConnection; target: SshTarget }
  | { ok: false; message: string }

export type TransferSink = (event: DirectSshTransferEvent) => void

export type ActiveTransfer = {
  id: string
  targetId: string
  label: string
  controller: AbortController
  sink: TransferSink
  lastProgressAt: number
}

/** What delegated transfer implementations (uploads, folder downloads) get from the runner. */
export type TransferHost = {
  deps: DirectSshTransferRunnerDeps
  emitProgress(transfer: ActiveTransfer, transferred: number, total: number): void
  fail(transfer: ActiveTransfer, message: string): void
  failOrCancel(transfer: ActiveTransfer, error: unknown): void
  endTransfer(transfer: ActiveTransfer): void
  claimUploadTemp(tempPath: string): boolean
  releaseUploadTemp(tempPath: string): void
}

const MAX_ACTIVE_TRANSFERS = 5
const PROGRESS_INTERVAL_MS = 200

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DirectSshTransferRunner {
  private readonly transfers = new Map<string, ActiveTransfer>()
  /** One download per destination: the resumable temp file cannot serve two writers. */
  private readonly activeDestinations = new Set<string>()
  private readonly activeUploadTemps = new Set<string>()

  constructor(readonly deps: DirectSshTransferRunnerDeps) {}

  isAtCapacity(): boolean {
    return this.transfers.size >= MAX_ACTIVE_TRANSFERS
  }

  cancel(transferId: string): void {
    this.transfers.get(transferId)?.controller.abort(new Error('Transfer canceled'))
  }

  /** Teardown (disconnect, removal): abort every transfer so nothing outlives its transport. */
  cancelForTarget(targetId: string): void {
    for (const transfer of this.transfers.values()) {
      if (transfer.targetId === targetId) {
        transfer.controller.abort(new Error('Connection closed'))
      }
    }
  }

  cancelAll(): void {
    for (const transfer of this.transfers.values()) {
      transfer.controller.abort(new Error('Connection closed'))
    }
  }

  async startFileDownload(
    targetId: string,
    remotePath: string,
    sink: TransferSink
  ): Promise<DirectSshTransferStartResult> {
    const defaultName = sanitizeLocalDownloadFilename(basename(remotePath))
    const win = this.deps.getMainWindow()
    const picked = win
      ? await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: defaultName })
      : { canceled: true, filePath: undefined }
    if (picked.canceled || !picked.filePath) {
      return { ok: false, cancelled: true, message: '' }
    }
    const destination = picked.filePath
    if (this.activeDestinations.has(destination)) {
      return { ok: false, message: 'A download to this location is already running.' }
    }
    this.activeDestinations.add(destination)
    const tempPath = downloadTempPath(destination)
    const transfer = this.beginTransfer(targetId, defaultName, sink)
    void this.runFileDownload(transfer, remotePath, destination, tempPath)
    return { ok: true, transferId: transfer.id }
  }

  async startFolderDownload(
    targetId: string,
    remotePath: string,
    sink: TransferSink
  ): Promise<DirectSshTransferStartResult> {
    const name = sanitizeLocalDownloadFilename(basename(remotePath))
    const win = this.deps.getMainWindow()
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose where to save the folder',
          properties: ['openDirectory', 'createDirectory']
        })
      : { canceled: true, filePaths: [] }
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, cancelled: true, message: '' }
    }
    const destination = join(picked.filePaths[0], name)
    const exists = await stat(destination).then(
      () => true,
      () => false
    )
    if (exists) {
      return { ok: false, message: `'${name}' already exists there. Choose another location.` }
    }
    const transfer = this.beginTransfer(targetId, name, sink)
    void this.runFolderDownload(transfer, remotePath, destination)
    return { ok: true, transferId: transfer.id }
  }

  async startUpload(
    targetId: string,
    remoteDir: string,
    sink: TransferSink
  ): Promise<DirectSshTransferStartResult> {
    const win = this.deps.getMainWindow()
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: `Upload to ${this.deps.getConnection(targetId)?.getTarget().label ?? targetId}`,
          properties: ['openFile', 'openDirectory', 'multiSelections']
        })
      : { canceled: true, filePaths: [] }
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, cancelled: true, message: '' }
    }
    const label =
      picked.filePaths.length === 1
        ? basename(picked.filePaths[0])
        : `${picked.filePaths.length} items`
    const transfer = this.beginTransfer(targetId, label, sink)
    void runUploadItems(this, transfer, remoteDir, picked.filePaths)
    return { ok: true, transferId: transfer.id }
  }

  beginTransfer(targetId: string, label: string, sink: TransferSink): ActiveTransfer {
    const transfer: ActiveTransfer = {
      id: randomUUID(),
      targetId,
      label,
      controller: new AbortController(),
      sink,
      lastProgressAt: 0
    }
    this.transfers.set(transfer.id, transfer)
    return transfer
  }

  /** Folder downloads report bytes (total grows as the walk discovers files); uploads count items. */
  emitProgress(transfer: ActiveTransfer, transferred: number, total: number): void {
    const now = Date.now()
    if (transferred !== total && now - transfer.lastProgressAt < PROGRESS_INTERVAL_MS) {
      return
    }
    transfer.lastProgressAt = now
    transfer.sink({
      kind: 'progress',
      transferId: transfer.id,
      label: transfer.label,
      transferred,
      total
    })
  }

  fail(transfer: ActiveTransfer, message: string): void {
    transfer.sink({ kind: 'error', transferId: transfer.id, label: transfer.label, message })
    this.transfers.delete(transfer.id)
  }

  failOrCancel(transfer: ActiveTransfer, error: unknown): void {
    if (transfer.controller.signal.aborted) {
      transfer.sink({ kind: 'cancelled', transferId: transfer.id, label: transfer.label })
    } else {
      transfer.sink({
        kind: 'error',
        transferId: transfer.id,
        label: transfer.label,
        message: errorMessage(error)
      })
    }
    this.transfers.delete(transfer.id)
  }

  endTransfer(transfer: ActiveTransfer): void {
    this.transfers.delete(transfer.id)
  }

  claimUploadTemp(tempPath: string): boolean {
    if (this.activeUploadTemps.has(tempPath)) {
      return false
    }
    this.activeUploadTemps.add(tempPath)
    return true
  }

  releaseUploadTemp(tempPath: string): void {
    this.activeUploadTemps.delete(tempPath)
  }

  private async runFileDownload(
    transfer: ActiveTransfer,
    remotePath: string,
    destination: string,
    tempPath: string
  ): Promise<void> {
    const connection = this.deps.getConnection(transfer.targetId)
    if (!connection) {
      this.fail(transfer, 'The host is not connected.')
      this.activeDestinations.delete(destination)
      return
    }
    let sftp: SFTPWrapper | null = null
    try {
      sftp = await connection.sftp()
      await resumeSftpDownload(sftp, remotePath, tempPath, {
        signal: transfer.controller.signal,
        onProgress: (transferred, total) => this.emitProgress(transfer, transferred, total)
      })
      sftpEndQuietly(sftp)
      sftp = null
      await rename(tempPath, destination)
      await cleanupDownloadArtifacts(tempPath)
      transfer.sink({ kind: 'done', transferId: transfer.id, label: transfer.label, skipped: 0 })
    } catch (error) {
      // The temp and its resume state survive: the next attempt to this destination continues.
      this.failOrCancel(transfer, error)
    } finally {
      if (sftp) {
        sftpEndQuietly(sftp)
      }
      this.transfers.delete(transfer.id)
      this.activeDestinations.delete(destination)
    }
  }

  private async runFolderDownload(
    transfer: ActiveTransfer,
    remotePath: string,
    destination: string
  ): Promise<void> {
    const connection = this.deps.getConnection(transfer.targetId)
    if (!connection) {
      this.fail(transfer, 'The host is not connected.')
      return
    }
    const tempDir = join(dirname(destination), `.orca-${randomUUID()}.part`)
    let sftp: SFTPWrapper | null = null
    try {
      sftp = await connection.sftp()
      const walker = new FolderDownloadWalker(
        sftp,
        transfer.controller.signal,
        (bytesDone, bytesTotal) => this.emitProgress(transfer, bytesDone, bytesTotal)
      )
      await mkdir(tempDir, { recursive: true })
      await walker.downloadTree(remotePath, tempDir, 0)
      sftpEndQuietly(sftp)
      sftp = null
      await rename(tempDir, destination)
      transfer.sink({
        kind: 'done',
        transferId: transfer.id,
        label: transfer.label,
        skipped: walker.skipped
      })
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      this.failOrCancel(transfer, error)
    } finally {
      if (sftp) {
        sftpEndQuietly(sftp)
      }
      this.transfers.delete(transfer.id)
    }
  }
}
