/** IPC for plain SSH terminals; the renderer names a saved target id and never any argv. */
import { homedir } from 'node:os'
import { ipcMain, type WebContents } from 'electron'
import {
  PLAIN_SSH_TERMINAL_CHANNELS,
  type PlainSshTerminalEvent
} from '../../../shared/plain-ssh-terminal'
import { isSshHostMoveBlocked } from '../../../shared/ssh-host-move-blocked'
import { mayUserSshConfigClaimAlias } from '../../ssh/config/ssh-config-alias-claim'
import { getSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { findSystemSsh } from '../../ssh/system-transport/system-ssh-binary'
import { ensureNodePtySpawnHelperExecutable } from '../../providers/local-pty-utils'
import {
  ackPlainSshTerminal,
  closePlainSshTerminal,
  closePlainSshTerminalsOwnedBy,
  openPlainSshTerminal,
  resizePlainSshTerminal,
  writePlainSshTerminal,
  type PlainSshTerminalDeps
} from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'
import { isDirectSshTarget } from '../../ssh/direct-ssh/direct-ssh-target'
import {
  DirectSshTerminalSessions,
  type DirectSshTerminalDeps
} from '../../ssh/direct-ssh/direct-ssh-terminal-sessions'
import {
  getDirectSshTerminalSessions,
  setDirectSshTerminalSessions
} from '../../ssh/direct-ssh/direct-ssh-registry'
import { connectionManager } from './ssh-ipc-context'

const deps: PlainSshTerminalDeps = {
  getTarget: (targetId) => getSshTargetRegistryStore()?.getTarget(targetId),
  isMoveBlocked: (targetId) => isSshHostMoveBlocked(getSshHostServerStatus(targetId)),
  findSsh: findSystemSsh,
  mayConfigClaimAlias: mayUserSshConfigClaimAlias,
  loadPtySpawn: async () => {
    // Packaged macOS updates can lose the node-pty spawn-helper executable bit.
    ensureNodePtySpawnHelperExecutable()
    return (await import('node-pty')).spawn
  },
  homeDir: homedir,
  platform: process.platform
}

const watchedOwners = new Set<number>()
const liveOwners = new Set<number>()

const directDeps: DirectSshTerminalDeps = {
  getConnection: (targetId) => connectionManager?.getConnection(targetId),
  isOwnerLive: (owner) => liveOwners.has(owner)
}
setDirectSshTerminalSessions(new DirectSshTerminalSessions(directDeps))

/** Plain SSH sessions cannot reattach after owner reload, crash or close. */
function endSessionsWithOwner(sender: WebContents): void {
  if (watchedOwners.has(sender.id)) {
    return
  }
  watchedOwners.add(sender.id)
  liveOwners.add(sender.id)
  const owner = sender.id
  const end = (): void => closePlainSshTerminalsOwnedBy(owner)
  // Direct SSH sessions only detach here: main keeps them so a reload or reopen reattaches.
  const detachDirect = (): void => getDirectSshTerminalSessions()?.detachOwner(owner)
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      detachDirect()
      end()
    }
  })
  sender.on('render-process-gone', () => {
    detachDirect()
    end()
  })
  sender.once('destroyed', () => {
    watchedOwners.delete(owner)
    liveOwners.delete(owner)
    detachDirect()
    end()
  })
}

export function registerPlainSshTerminalHandlers(): void {
  const { open, write, resize, close, ack, event } = PLAIN_SSH_TERMINAL_CHANNELS
  ipcMain.removeHandler(open)
  ipcMain.removeAllListeners(write)
  ipcMain.removeAllListeners(resize)
  ipcMain.removeAllListeners(close)
  ipcMain.removeAllListeners(ack)

  ipcMain.handle(
    open,
    async (ipcEvent, args: { targetId?: unknown; cols?: unknown; rows?: unknown }) => {
      const sender = ipcEvent.sender
      endSessionsWithOwner(sender)
      const sink = (payload: PlainSshTerminalEvent): boolean => {
        if (sender.isDestroyed()) {
          return false
        }
        sender.send(event, payload)
        return true
      }
      const target =
        typeof args?.targetId === 'string'
          ? getSshTargetRegistryStore()?.getTarget(args.targetId)
          : undefined
      if (target && !target.owner && isDirectSshTarget(target)) {
        const result = await getDirectSshTerminalSessions()!.open(
          target.id,
          sender.id,
          { cols: args?.cols, rows: args?.rows },
          sink
        )
        return result.ok ? { ...result, label: target.label } : result
      }
      return openPlainSshTerminal(
        deps,
        { targetId: args?.targetId, cols: args?.cols, rows: args?.rows, owner: sender.id },
        sink
      )
    }
  )
  ipcMain.on(write, (ipcEvent, args: { sessionId?: unknown; data?: unknown }) => {
    writePlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.data)
  })
  ipcMain.on(resize, (ipcEvent, args: { sessionId?: unknown; cols?: unknown; rows?: unknown }) => {
    resizePlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.cols, args?.rows)
  })
  ipcMain.on(close, (ipcEvent, args: { sessionId?: unknown }) => {
    closePlainSshTerminal(args?.sessionId, ipcEvent.sender.id)
  })
  ipcMain.on(ack, (ipcEvent, args: { sessionId?: unknown; chars?: unknown }) => {
    ackPlainSshTerminal(args?.sessionId, ipcEvent.sender.id, args?.chars)
  })
}
