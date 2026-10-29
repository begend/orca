import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type IpcHandler = (payload: unknown) => unknown
  const handle = vi.fn<(channel: string, handler: IpcHandler) => void>()
  const on = vi.fn<(channel: string, handler: IpcHandler) => void>()
  const directSessions = {
    hasSession: vi.fn((): boolean => false),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    ack: vi.fn(),
    listSessions: vi.fn((): { sessionId: string; cols: number; rows: number }[] => []),
    open: vi.fn()
  }
  return {
    electron: {
      ipcMain: { handle, on, removeHandler: vi.fn(), removeAllListeners: vi.fn() }
    },
    directSessions,
    registry: {
      getDirectSshTerminalSessions: vi.fn(() => directSessions),
      setDirectSshTerminalSessions: vi.fn()
    },
    directTarget: { isDirectSshTarget: vi.fn((): boolean => true) },
    targetStore: {
      getSshTargetRegistryStore: vi.fn(() => ({
        getTarget: vi.fn((id: string) => ({ id, label: id, host: 'h', port: 22 }))
      }))
    },
    legacy: {
      openPlainSshTerminal: vi.fn(),
      writePlainSshTerminal: vi.fn(),
      resizePlainSshTerminal: vi.fn(),
      closePlainSshTerminal: vi.fn(),
      ackPlainSshTerminal: vi.fn(),
      closePlainSshTerminalsOwnedBy: vi.fn()
    }
  }
})

vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions', () => mocks.legacy)
vi.mock('../../ssh/direct-ssh/direct-ssh-registry', () => mocks.registry)
vi.mock('../../ssh/direct-ssh/direct-ssh-terminal-sessions', () => ({
  DirectSshTerminalSessions: vi.fn()
}))
vi.mock('../../ssh/direct-ssh/direct-ssh-target', () => mocks.directTarget)
vi.mock('../../ssh/targets/ssh-target-registry', () => mocks.targetStore)
vi.mock('../../ssh/ssh-host-server-status', () => ({ getSshHostServerStatus: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-alias-claim', () => ({ mayUserSshConfigClaimAlias: vi.fn() }))
vi.mock('../../ssh/system-transport/system-ssh-binary', () => ({ findSystemSsh: vi.fn() }))
vi.mock('../../providers/local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn()
}))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: undefined }))

import { registerPlainSshTerminalHandlers } from './plain-ssh-terminal-handlers'

function ipcChannelHandlers(): Map<string, (...args: unknown[]) => unknown> {
  const byChannel = new Map<string, (...args: unknown[]) => unknown>()
  const capture = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    byChannel.set(channel, handler)
  }
  for (const [channel, handler] of mocks.electron.ipcMain.handle.mock.calls) {
    capture(channel, handler)
  }
  for (const [channel, handler] of mocks.electron.ipcMain.on.mock.calls) {
    capture(channel, handler)
  }
  return byChannel
}

function ipcEvent(senderId: number) {
  return {
    sender: {
      id: senderId,
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn()
    }
  }
}

describe('plain SSH terminal IPC dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.registry.getDirectSshTerminalSessions.mockReturnValue(mocks.directSessions)
    mocks.directSessions.hasSession.mockReturnValue(false)
    mocks.directTarget.isDirectSshTarget.mockReturnValue(true)
    registerPlainSshTerminalHandlers()
  })

  it('routes write/resize/ack/close to direct sessions by id', () => {
    const handlers = ipcChannelHandlers()
    mocks.directSessions.hasSession.mockReturnValue(true)

    handlers.get('plainSsh:write')!(ipcEvent(7), { sessionId: 'd1', data: 'ls\n' })
    handlers.get('plainSsh:resize')!(ipcEvent(7), { sessionId: 'd1', cols: 100, rows: 30 })
    handlers.get('plainSsh:ack')!(ipcEvent(7), { sessionId: 'd1', chars: 12 })
    handlers.get('plainSsh:close')!(ipcEvent(7), { sessionId: 'd1' })

    expect(mocks.directSessions.write).toHaveBeenCalledWith('d1', 7, 'ls\n')
    expect(mocks.directSessions.resize).toHaveBeenCalledWith('d1', 7, 100, 30)
    expect(mocks.directSessions.ack).toHaveBeenCalledWith('d1', 7, 12)
    expect(mocks.directSessions.close).toHaveBeenCalledWith('d1', 7)
    expect(mocks.legacy.writePlainSshTerminal).not.toHaveBeenCalled()
    expect(mocks.legacy.resizePlainSshTerminal).not.toHaveBeenCalled()
    expect(mocks.legacy.ackPlainSshTerminal).not.toHaveBeenCalled()
    expect(mocks.legacy.closePlainSshTerminal).not.toHaveBeenCalled()
  })

  it('keeps the legacy PTY route for system-ssh sessions', () => {
    const handlers = ipcChannelHandlers()

    handlers.get('plainSsh:write')!(ipcEvent(7), { sessionId: 'pty-1', data: 'ls\n' })
    handlers.get('plainSsh:close')!(ipcEvent(7), { sessionId: 'pty-1' })

    expect(mocks.legacy.writePlainSshTerminal).toHaveBeenCalledWith('pty-1', 7, 'ls\n')
    expect(mocks.legacy.closePlainSshTerminal).toHaveBeenCalledWith('pty-1', 7)
    expect(mocks.directSessions.write).not.toHaveBeenCalled()
    expect(mocks.directSessions.close).not.toHaveBeenCalled()
  })

  it('passes direct open options through and labels the settled session', async () => {
    const handlers = ipcChannelHandlers()
    mocks.directSessions.open.mockResolvedValue({ ok: true, sessionId: 'd1' })

    const result = await handlers.get('plainSsh:open')!(ipcEvent(7), {
      targetId: 't1',
      cols: 100,
      rows: 30,
      newSession: true,
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })

    expect(mocks.directSessions.open).toHaveBeenCalledWith(
      't1',
      7,
      {
        cols: 100,
        rows: 30,
        newSession: true,
        sessionId: undefined,
        tabId: 'tab-1',
        leafId: 'leaf-1'
      },
      expect.any(Function)
    )
    expect(result).toEqual({ ok: true, sessionId: 'd1', label: 't1' })
  })

  it('lists adoptable direct sessions only for direct targets', () => {
    const handlers = ipcChannelHandlers()
    mocks.directSessions.listSessions.mockReturnValue([
      { sessionId: 'd1', cols: 100, rows: 30 },
      { sessionId: 'd2', cols: 80, rows: 24 }
    ])

    expect(handlers.get('plainSsh:list')!(ipcEvent(7), { targetId: 't1' })).toEqual({
      sessions: [
        { sessionId: 'd1', cols: 100, rows: 30 },
        { sessionId: 'd2', cols: 80, rows: 24 }
      ]
    })
    expect(mocks.directSessions.listSessions).toHaveBeenCalledWith('t1', 7)

    mocks.directTarget.isDirectSshTarget.mockReturnValue(false)
    expect(handlers.get('plainSsh:list')!(ipcEvent(7), { targetId: 't1' })).toEqual({
      sessions: []
    })
    expect(mocks.directSessions.listSessions).toHaveBeenCalledTimes(1)
  })
})
