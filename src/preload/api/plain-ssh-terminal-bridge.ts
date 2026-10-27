import { ipcRenderer } from 'electron'
import {
  PLAIN_SSH_TERMINAL_CHANNELS,
  type PlainSshTerminalEvent,
  type PlainSshTerminalListResult,
  type PlainSshTerminalOpenRequest,
  type PlainSshTerminalOpenResult
} from '../../shared/plain-ssh-terminal'

export type PlainSshTerminalApi = {
  open: (args: PlainSshTerminalOpenRequest) => Promise<PlainSshTerminalOpenResult>
  /** Direct hosts only: session ids the calling window may attach (its own or detached ones). */
  list: (args: { targetId: string }) => Promise<PlainSshTerminalListResult>
  write: (args: { sessionId: string; data: string }) => void
  resize: (args: { sessionId: string; cols: number; rows: number }) => void
  close: (args: { sessionId: string }) => void
  ack: (args: { sessionId: string; chars: number }) => void
  onEvent: (callback: (event: PlainSshTerminalEvent) => void) => () => void
}

export const plainSshTerminalApi: PlainSshTerminalApi = {
  open: (args) => ipcRenderer.invoke(PLAIN_SSH_TERMINAL_CHANNELS.open, args),
  list: (args) => ipcRenderer.invoke(PLAIN_SSH_TERMINAL_CHANNELS.list, args),
  write: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.write, args),
  resize: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.resize, args),
  close: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.close, args),
  ack: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.ack, args),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PlainSshTerminalEvent): void =>
      callback(payload)
    ipcRenderer.on(PLAIN_SSH_TERMINAL_CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(PLAIN_SSH_TERMINAL_CHANNELS.event, listener)
  }
}
