import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import type { PlainSshTerminalEvent } from '../../../shared/plain-ssh-terminal'
import type { SshConnectionState } from '../../../shared/ssh-types'
import {
  DirectSshTerminalSessions,
  type DirectSshConnectionLike
} from './direct-ssh-terminal-sessions'

// SAFETY: tests drive the session logic through a minimal stand-in for ssh2's ClientChannel.
type FakeChannel = ClientChannel & {
  emitData(text: string): void
  emitClose(): void
  emitExit(code: number | null): void
}
function fakeChannel(): FakeChannel {
  const listeners = new Map<string, ((arg: unknown) => void)[]>()
  const channel = {
    on(event: string, listener: (arg: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return channel
    },
    write: vi.fn(),
    close: vi.fn(),
    setWindow: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData(text: string) {
      for (const listener of listeners.get('data') ?? []) {
        listener(Buffer.from(text, 'utf8'))
      }
    },
    emitExit(code: number | null) {
      for (const listener of listeners.get('exit') ?? []) {
        listener(code)
      }
    },
    emitClose() {
      for (const listener of listeners.get('close') ?? []) {
        listener(undefined)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal stand-in for ssh2's ClientChannel; only the session logic's surface is implemented.
  return channel as unknown as FakeChannel
}

const SIZES = { cols: 80, rows: 24 }

function harness(initialStatus: SshConnectionState['status'] = 'connected'): {
  sessions: DirectSshTerminalSessions
  connection: DirectSshConnectionLike & {
    channels: FakeChannel[]
    status: SshConnectionState['status']
  }
  events: PlainSshTerminalEvent[]
  sink: (event: PlainSshTerminalEvent) => boolean
} {
  const connection: DirectSshConnectionLike & {
    channels: FakeChannel[]
    status: SshConnectionState['status']
  } = {
    status: initialStatus,
    channels: [],
    isDisposed: () => false,
    getState: () => ({
      targetId: 't1',
      status: connection.status,
      error: null,
      reconnectAttempt: 0
    }),
    shell: async () => {
      const channel = fakeChannel()
      connection.channels.push(channel)
      return channel
    }
  }
  const sessions = new DirectSshTerminalSessions({
    getConnection: () => connection,
    isOwnerLive: () => true
  })
  const events: PlainSshTerminalEvent[] = []
  const sink = (event: PlainSshTerminalEvent) => {
    events.push(event)
    return true
  }
  return { sessions, connection, events, sink }
}

describe('DirectSshTerminalSessions', () => {
  it('refuses to open when the host has no live connection', async () => {
    const connection = harness('connected').connection
    const sessions = new DirectSshTerminalSessions({
      getConnection: (targetId) => (targetId === 't1' ? undefined : connection),
      isOwnerLive: () => true
    })
    await expect(sessions.open('t1', 1, SIZES, () => true)).resolves.toEqual({
      ok: false,
      reason: 'not-connected'
    })
  })

  it('opens one session per target, streams output, and reports already-open to a second window', async () => {
    const { sessions, connection } = harness()
    const first: PlainSshTerminalEvent[] = []
    const open = await sessions.open('t1', 1, SIZES, (event) => {
      first.push(event)
      return true
    })
    expect(open.ok).toBe(true)
    expect(typeof (open.ok ? open.sessionId : '')).toBe('string')
    expect(connection.channels).toHaveLength(1)

    connection.channels[0].emitData('hello')
    expect(first.filter((event) => event.kind === 'data')).toHaveLength(1)

    const second = await sessions.open('t1', 2, SIZES, () => true)
    expect(second).toEqual({ ok: false, reason: 'already-open' })
    expect(connection.channels).toHaveLength(1)
  })

  it('ends the session with 255 when the shell dies while the transport is healthy', async () => {
    const { sessions, connection, events, sink } = harness()
    const open = await sessions.open('t1', 1, SIZES, sink)
    if (!open.ok) {
      throw new Error('open failed')
    }
    connection.channels[0].emitClose()
    const exit = events.find((event) => event.kind === 'exit')
    expect(exit).toEqual({ kind: 'exit', sessionId: open.sessionId, exitCode: 255 })
  })

  it('keeps the same session across a transport drop and reattaches on reconnect', async () => {
    const { sessions, connection, events, sink } = harness()
    const open = await sessions.open('t1', 1, SIZES, sink)
    if (!open.ok) {
      throw new Error('open failed')
    }
    connection.status = 'reconnecting'
    connection.channels[0].emitClose()
    expect(events.some((event) => event.kind === 'reconnecting')).toBe(true)

    connection.status = 'connected'
    sessions.notifyConnectionState('t1', 'connected')
    // The replacement channel opens synchronously; the reattached event follows two microtasks later.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(connection.channels).toHaveLength(2)
    expect(events.some((event) => event.kind === 'reconnected')).toBe(true)

    // Input and output now flow through the replacement channel only.
    sessions.write(open.sessionId, 1, 'ls\n')
    expect(connection.channels[0].write).not.toHaveBeenCalled()
    expect(connection.channels[1].write).toHaveBeenCalledWith('ls\n')
  })

  it('reports a remote clean exit with its own code', async () => {
    const { sessions, connection, events, sink } = harness()
    const open = await sessions.open('t1', 1, SIZES, sink)
    if (!open.ok) {
      throw new Error('open failed')
    }
    connection.channels[0].emitExit(0)
    connection.channels[0].emitClose()
    expect(events.at(-1)).toEqual({ kind: 'exit', sessionId: open.sessionId, exitCode: 0 })
  })
})
