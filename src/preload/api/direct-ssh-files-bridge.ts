import { ipcRenderer } from 'electron'
import {
  DIRECT_SSH_FILE_CHANNELS,
  type DirectSshBrowseResult,
  type DirectSshTransferEvent,
  type DirectSshTransferStartResult
} from '../../shared/direct-ssh-files'

export type DirectSshFilesApi = {
  home: (args: { targetId: string }) => Promise<DirectSshBrowseResult>
  list: (args: { targetId: string; path: string }) => Promise<DirectSshBrowseResult>
  download: (args: { targetId: string; path: string }) => Promise<DirectSshTransferStartResult>
  upload: (args: { targetId: string; path: string }) => Promise<DirectSshTransferStartResult>
  cancel: (args: { transferId: string }) => void
  onEvent: (callback: (event: DirectSshTransferEvent) => void) => () => void
}

export const directSshFilesApi: DirectSshFilesApi = {
  home: (args) => ipcRenderer.invoke(DIRECT_SSH_FILE_CHANNELS.home, args),
  list: (args) => ipcRenderer.invoke(DIRECT_SSH_FILE_CHANNELS.list, args),
  download: (args) => ipcRenderer.invoke(DIRECT_SSH_FILE_CHANNELS.download, args),
  upload: (args) => ipcRenderer.invoke(DIRECT_SSH_FILE_CHANNELS.upload, args),
  cancel: (args) => ipcRenderer.send(DIRECT_SSH_FILE_CHANNELS.cancel, args),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DirectSshTransferEvent): void =>
      callback(payload)
    ipcRenderer.on(DIRECT_SSH_FILE_CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(DIRECT_SSH_FILE_CHANNELS.event, listener)
  }
}
