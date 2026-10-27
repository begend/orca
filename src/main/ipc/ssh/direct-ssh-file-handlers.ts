/** IPC for the Direct SSH file explorer: the renderer names a target id and remote paths;
 * pickers, temp paths and promotion stay in main. A destroyed requester aborts its transfers. */
import { ipcMain, type WebContents } from 'electron'
import {
  DIRECT_SSH_FILE_CHANNELS,
  type DirectSshTransferEvent
} from '../../../shared/direct-ssh-files'
import { DirectSshFileService } from '../../ssh/direct-ssh/direct-ssh-file-service'
import {
  getDirectSshFileService,
  setDirectSshFileService
} from '../../ssh/direct-ssh/direct-ssh-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'

setDirectSshFileService(
  new DirectSshFileService({
    getConnection: (targetId) => connectionManager?.getConnection(targetId),
    getMainWindow: () => getCurrentMainWindow()
  })
)

/** Binds events to the requesting window; a dead window aborts the transfer on its next event. */
function sinkFor(
  sender: WebContents,
  service: DirectSshFileService
): (event: DirectSshTransferEvent) => void {
  return (event) => {
    if (sender.isDestroyed() || sender.isCrashed()) {
      service.cancel(event.transferId)
      return
    }
    sender.send(DIRECT_SSH_FILE_CHANNELS.event, event)
  }
}

export function registerDirectSshFileHandlers(): void {
  const service = getDirectSshFileService()!
  const { home, list, download, upload, cancel } = DIRECT_SSH_FILE_CHANNELS
  ipcMain.removeHandler(home)
  ipcMain.removeHandler(list)
  ipcMain.removeHandler(download)
  ipcMain.removeHandler(upload)
  ipcMain.removeAllListeners(cancel)

  ipcMain.handle(home, async (_ipcEvent, args: { targetId?: unknown }) => {
    return typeof args?.targetId === 'string'
      ? service.home(args.targetId)
      : { ok: false, message: 'A target id is required.' }
  })

  ipcMain.handle(list, async (_ipcEvent, args: { targetId?: unknown; path?: unknown }) => {
    return typeof args?.targetId === 'string' && typeof args?.path === 'string'
      ? service.list(args.targetId, args.path)
      : { ok: false, message: 'A target id and path are required.' }
  })

  ipcMain.handle(download, async (ipcEvent, args: { targetId?: unknown; path?: unknown }) => {
    if (typeof args?.targetId !== 'string' || typeof args?.path !== 'string') {
      return { ok: false, message: 'A target id and path are required.' }
    }
    return service.startDownload(args.targetId, args.path, sinkFor(ipcEvent.sender, service))
  })

  ipcMain.handle(upload, async (ipcEvent, args: { targetId?: unknown; path?: unknown }) => {
    if (typeof args?.targetId !== 'string' || typeof args?.path !== 'string') {
      return { ok: false, message: 'A target id and folder path are required.' }
    }
    return service.startUpload(args.targetId, args.path, sinkFor(ipcEvent.sender, service))
  })

  ipcMain.on(cancel, (_ipcEvent, args: { transferId?: unknown }) => {
    if (typeof args?.transferId === 'string') {
      service.cancel(args.transferId)
    }
  })
}
