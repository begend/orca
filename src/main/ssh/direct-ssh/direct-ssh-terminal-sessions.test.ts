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

  it('opens independent shells per tab and keeps their input and output apart', async () => {
    const { sessions, connection } = harness()
    const first: PlainSshTerminalEvent[] = []
    const second: PlainSshTerminalEvent[] = []
    const one = await sessions.open('t1', 1, SIZES, (event) => {
      first.push(event)
      return true
    })
    const two = await sessions.open('t1', 1, { ...SIZES, newSession: true }, (event) => {
      second.push(event)
      return true
    })
    if (!one.ok || !two.ok) {
      throw new Error('open failed')
    }
    expect(one.sessionId).not.toBe(two.sessionId)
    expect(connection.channels).toHaveLength(2)

    sessions.write(one.sessionId, 1, 'ls\n')
    sessions.write(two.sessionId, 1, 'pwd\n')
    expect(connection.channels[0].write).toHaveBeenCalledWith('ls\n')
    expect(connection.channels[1].write).toHaveBeenCalledWith('pwd\n')

    connection.channels[1].emitData('from-two')
    expect(first.filter((event) => event.kind === 'data')).toHaveLength(0)
    expect(second.some((event) => event.kind === 'data' && event.data === 'from-two')).toBe(true)

    // Closing one tab leaves the other shell fully live.
    sessions.close(one.sessionId, 1)
    expect(connection.channels[0].close).toHaveBeenCalled()
    sessions.write(two.sessionId, 1, 'still-here\n')
    expect(connection.channels[1].write).toHaveBeenLastCalledWith('still-here\n')
  })

  it('reattaches every surviving tab after a transport drop', async () => {
    const { sessions, connection, events, sink } = harness()
    const one = await sessions.open('t1', 1, SIZES, sink)
    const two = await sessions.open('t1', 1, { ...SIZES, newSession: true }, sink)
    if (!one.ok || !two.ok) {
      throw new Error('open failed')
    }
    connection.status = 'reconnecting'
    connection.channels[0].emitClose()
    connection.channels[1].emitClose()
    expect(events.filter((event) => event.kind === 'reconnecting')).toHaveLength(2)

    connection.status = 'connected'
    sessions.notifyConnectionState('t1', 'connected')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(connection.channels).toHaveLength(4)
    expect(events.filter((event) => event.kind === 'reconnected')).toHaveLength(2)

    // Each logical session id keeps writing through its own replacement channel.
    sessions.write(one.sessionId, 1, 'a\n')
    sessions.write(two.sessionId, 1, 'b\n')
    expect(connection.channels[2].write).toHaveBeenCalledWith('a\n')
    expect(connection.channels[3].write).toHaveBeenCalledWith('b\n')
  })

  it('lists adoptable sessions and reattaches a specific one after a reload', async () => {
    const { sessions } = harness()
    const first = await sessions.open('t1', 1, SIZES, () => true)
    const second = await sessions.open('t1', 1, { ...SIZES, newSession: true }, () => true)
    if (!first.ok || !second.ok) {
      throw new Error('open failed')
    }
    expect(sessions.listSessions('t1', 1)).toEqual([first.sessionId, second.sessionId])

    // Reload detaches; the reopening window sees and adopts both under their original ids.
    sessions.detachOwner(1)
    expect(sessions.listSessions('t1', 2)).toEqual([first.sessionId, second.sessionId])
    const reattached = await sessions.open('t1', 2, SIZES, () => true)
    expect(reattached).toEqual({ ok: true, sessionId: first.sessionId })

    // Attaching an unknown id reports a cancelled open instead of a phantom shell.
    await expect(
      sessions.open('t1', 2, { ...SIZES, sessionId: 'gone' }, () => true)
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('hides a host from a second live window until its owner detaches', async () => {
    const { sessions } = harness()
    const open = await sessions.open('t1', 1, SIZES, () => true)
    if (!open.ok) {
      throw new Error('open failed')
    }
    expect(sessions.listSessions('t1', 2)).toEqual([])
    await expect(sessions.open('t1', 2, SIZES, () => true)).resolves.toEqual({
      ok: false,
      reason: 'already-open'
    })
    sessions.detachOwner(1)
    expect(sessions.listSessions('t1', 2)).toEqual([open.sessionId])
  })

  it('applies the attaching xterm size and drains acks before any pause', async () => {
    const { sessions, connection } = harness()
    const open = await sessions.open('t1', 1, SIZES, () => true)
    if (!open.ok) {
      throw new Error('open failed')
    }
    sessions.detachOwner(1)
    await sessions.open('t1', 2, { cols: 120, rows: 40 }, () => true)
    expect(connection.channels[0].setWindow).toHaveBeenCalledWith(40, 120, 0, 0)

    // Acks drain rendered output before any pause, so a burst cannot spuriously throttle later.
    connection.channels[0].emitData('x'.repeat(100 * 1024))
    sessions.ack(open.sessionId, 2, 100 * 1024)
    expect(connection.channels[0].resume).not.toHaveBeenCalled()

    // Crossing the pause threshold pauses; enough rendered bytes resume it again.
    connection.channels[0].emitData('y'.repeat(600 * 1024))
    expect(connection.channels[0].pause).toHaveBeenCalled()
    sessions.ack(open.sessionId, 2, 600 * 1024)
    expect(connection.channels[0].resume).toHaveBeenCalled()
  })
})
