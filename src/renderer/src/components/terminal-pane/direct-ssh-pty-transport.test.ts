// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createDirectSshPtyTransport } from './direct-ssh-pty-transport'
import { toDirectSshPtyId } from '../../../../shared/direct-ssh-pty-id'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenRequest,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'

const open = vi.fn<(args: PlainSshTerminalOpenRequest) => Promise<PlainSshTerminalOpenResult>>()
const close = vi.fn()
const ack = vi.fn()
const write = vi.fn()
const resize = vi.fn()
let emit: (event: PlainSshTerminalEvent) => void = () => {}
const subscribers = new Set<(event: PlainSshTerminalEvent) => void>()

beforeEach(() => {
  open.mockReset()
  close.mockReset()
  ack.mockReset()
  write.mockReset()
  resize.mockReset()
  subscribers.clear()
  emit = (event) => {
    for (const subscriber of subscribers) {
      subscriber(event)
    }
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plainSsh: {
        open,
        close,
        ack,
        write,
        resize,
        onEvent: (callback: (event: PlainSshTerminalEvent) => void) => {
          subscribers.add(callback)
          return () => subscribers.delete(callback)
        }
      }
    }
  })
})

function makeTransport() {
  return createDirectSshPtyTransport({
    targetId: 'host-a',
    transportOptions: {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      onPtyExit: vi.fn(),
      onPtySpawn: vi.fn()
    }
  })
}

const noopCallbacks = () => ({})

describe('direct SSH pty transport', () => {
  it('opens a fresh shell on connect and binds a namespaced pty id', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's1', label: 'host-a' })
    const transport = makeTransport()
    const onConnect = vi.fn()
    const result = await transport.connect({
      url: '',
      cols: 100,
      rows: 30,
      callbacks: { onConnect }
    })
    expect(open).toHaveBeenCalledWith({
      targetId: 'host-a',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      cols: 100,
      rows: 30,
      newSession: true
    })
    expect(result).toEqual({ id: toDirectSshPtyId('s1'), isReattach: false })
    expect(transport.getPtyId()).toBe(toDirectSshPtyId('s1'))
    expect(transport.isConnected()).toBe(true)
    expect(onConnect).toHaveBeenCalled()
  })

  it('attaches a listed logical session by id and reports it as a reattach', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's2', label: 'host-a' })
    const transport = makeTransport()
    const result = await transport.connect({
      url: '',
      sessionId: toDirectSshPtyId('s2'),
      cols: 80,
      rows: 24,
      callbacks: noopCallbacks()
    })
    expect(open).toHaveBeenCalledWith({
      targetId: 'host-a',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      cols: 80,
      rows: 24,
      sessionId: 's2'
    })
    expect(result).toEqual({ id: toDirectSshPtyId('s2'), isReattach: true })
  })

  it('queues prompt output emitted before open resolves', async () => {
    const pending = Promise.withResolvers<PlainSshTerminalOpenResult>()
    open.mockReturnValue(pending.promise)
    const onData = vi.fn()
    const transport = makeTransport()
    const connecting = transport.connect({ url: '', callbacks: { onData } })

    emit({ kind: 'data', sessionId: 's-prompt', data: '$ ' })
    pending.resolve({ ok: true, sessionId: 's-prompt', label: 'host-a' })
    await connecting

    expect(onData).toHaveBeenCalledWith('$ ')
    expect(ack).toHaveBeenCalledWith({ sessionId: 's-prompt', chars: 2 })
  })

  it('removes its event listener after a failed open', async () => {
    open.mockResolvedValue({ ok: false, reason: 'not-connected' })
    const transport = makeTransport()

    await expect(transport.connect({ url: '', callbacks: noopCallbacks() })).rejects.toThrow(
      'not connected'
    )

    expect(subscribers).toHaveLength(0)
  })

  it('closes a session whose open resolves after transport destruction', async () => {
    const pending = Promise.withResolvers<PlainSshTerminalOpenResult>()
    open.mockReturnValue(pending.promise)
    const transport = makeTransport()
    const connecting = transport.connect({ url: '', callbacks: noopCallbacks() })

    transport.destroy!()
    pending.resolve({ ok: true, sessionId: 's-late', label: 'host-a' })

    await expect(connecting).rejects.toThrow('replaced before it connected')
    expect(close).toHaveBeenCalledWith({ sessionId: 's-late' })
    expect(transport.getPtyId()).toBeNull()
  })

  it('delivers data, acks rendered chars, and surfaces remote exit', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's3', label: 'host-a' })
    const onData = vi.fn()
    const onExit = vi.fn()
    const onPtyExit = vi.fn()
    const transportWithOptions = createDirectSshPtyTransport({
      targetId: 'host-a',
      transportOptions: { onPtyExit }
    })
    await transportWithOptions.connect({ url: '', callbacks: { onData, onExit } })

    emit({ kind: 'data', sessionId: 's3', data: 'hello' })
    expect(onData).toHaveBeenCalledWith('hello')
    expect(ack).toHaveBeenCalledWith({ sessionId: 's3', chars: 5 })

    emit({ kind: 'exit', sessionId: 's3', exitCode: 2 })
    expect(onExit).toHaveBeenCalledWith(2)
    expect(onPtyExit).toHaveBeenCalledWith(toDirectSshPtyId('s3'), 2)
    expect(transportWithOptions.isConnected()).toBe(false)
    // A remote exit must not send close: the session is already gone.
    expect(close).not.toHaveBeenCalled()
  })

  it('presents channel rotation as transport-internal recovery, not a pty rebind', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's4', label: 'host-a' })
    const transport = makeTransport()
    const onDisconnect = vi.fn()
    const onStreamRecovered = vi.fn()
    const onExit = vi.fn()
    await transport.connect({ url: '', callbacks: { onDisconnect, onStreamRecovered, onExit } })

    emit({ kind: 'reconnecting', sessionId: 's4' })
    expect(transport.getRecoveryState!().phase).toBe('recovering')
    expect(transport.ownsRecovery!()).toBe(true)
    expect(onDisconnect).toHaveBeenCalled()

    emit({ kind: 'reconnected', sessionId: 's4' })
    expect(transport.getRecoveryState!().phase).toBe('connected')
    expect(onStreamRecovered).toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('keeps the session alive on detach and ends it only on explicit disconnect', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's5', label: 'host-a' })
    const transport = makeTransport()
    await transport.connect({ url: '', callbacks: noopCallbacks() })

    transport.detach!()
    expect(close).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()

    await transport.connect({
      url: '',
      sessionId: toDirectSshPtyId('s5'),
      callbacks: noopCallbacks()
    })
    transport.disconnect!()
    expect(close).toHaveBeenCalledWith({ sessionId: 's5' })
  })

  it('ends the logical session when the pane transport is destroyed', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's6', label: 'host-a' })
    const transport = makeTransport()
    await transport.connect({ url: '', callbacks: noopCallbacks() })

    transport.destroy!()

    expect(close).toHaveBeenCalledWith({ sessionId: 's6' })
    expect(transport.getPtyId()).toBeNull()
    expect(transport.getRecoveryState!().phase).toBe('disposed')
  })

  it('suspends acking while output is paused so main backpressure engages', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's6', label: 'host-a' })
    const transport = makeTransport()
    await transport.connect({ url: '', callbacks: noopCallbacks() })

    transport.setOutputPaused!(true)
    emit({ kind: 'data', sessionId: 's6', data: 'held' })
    expect(ack).not.toHaveBeenCalled()

    transport.setOutputPaused!(false)
    expect(ack).toHaveBeenCalledWith({ sessionId: 's6', chars: 4 })
  })

  it('writes input and resize through the session registry', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's7', label: 'host-a' })
    const transport = makeTransport()
    await transport.connect({ url: '', cols: 90, rows: 28, callbacks: noopCallbacks() })

    expect(transport.sendInput('ls\r', 'driving')).toBe(true)
    expect(write).toHaveBeenCalledWith({ sessionId: 's7', data: 'ls\r' })
    expect(transport.resize(120, 40)).toBe(true)
    expect(resize).toHaveBeenCalledWith({ sessionId: 's7', cols: 120, rows: 40 })
  })
})
