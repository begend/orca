import type { PtyDataMeta } from './pty-dispatcher'
import type {
  IpcPtyTransportOptions,
  PtyConnectResult,
  PtyTransport,
  PtyTransportRecoveryState
} from './pty-transport-types'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'
import { parseDirectSshPtyId, toDirectSshPtyId } from '../../../../shared/direct-ssh-pty-id'

/** The subset of PtyCallbacks this transport consumes (the type is not exported). */
type DirectSshCallbacks = {
  onConnect?: () => void
  onDisconnect?: () => void
  onStreamRecovered?: () => void
  onData?: (data: string, meta?: PtyDataMeta) => void
  onExit?: (code: number) => void
  onError?: (message: string, errors?: string[]) => void
}

/** Why a dedicated factory: direct sessions live in main's `DirectSshTerminalSessions`, not the
 * daemon PTY provider. This transport keeps the canonical pane pipeline (input, resize, recovery
 * overlay, layout bindings) working over `window.api.plainSsh` while preserving direct semantics:
 * logical session ids survive renderer reloads (detach ≠ close) and reconnects rotate the ssh2
 * channel without changing the id. Output ACK flow control from the legacy standalone view is
 * preserved; while the pane's delivery gate pauses output we stop ACKing so main's 512 KiB
 * backpressure engages instead of buffering unbounded output in a hidden renderer. */
export function createDirectSshPtyTransport(options: {
  targetId: string
  transportOptions: IpcPtyTransportOptions
}): PtyTransport {
  const { targetId, transportOptions } = options
  let storedCallbacks: DirectSshCallbacks = {}
  let sessionId: string | null = null
  let connected = false
  let destroyed = false
  let outputPaused = false
  let pausedUnackedChars = 0
  let recoveryEpoch = 0
  let reconnecting = false
  let openGeneration = 0
  let pendingOpenEvents: PlainSshTerminalEvent[] = []
  let unsubscribe: (() => void) | null = null

  const api = (): NonNullable<typeof window.api.plainSsh> => {
    const bridge = window.api.plainSsh
    if (!bridge) {
      throw new Error('Direct SSH terminals are not available in this build.')
    }
    return bridge
  }

  const rawSessionId = (): string | null => parseDirectSshPtyId(sessionId)

  const ack = (chars: number): void => {
    const raw = rawSessionId()
    if (!raw || chars <= 0) {
      return
    }
    if (outputPaused) {
      pausedUnackedChars += chars
      return
    }
    try {
      api().ack({ sessionId: raw, chars })
    } catch {
      // A torn-down bridge must not break the output pipeline; main cleans up on teardown.
    }
  }

  const handleEvent = (event: PlainSshTerminalEvent): void => {
    const raw = rawSessionId()
    if (destroyed || event.sessionId !== raw) {
      if (!destroyed && !raw) {
        pendingOpenEvents.push(event)
      }
      return
    }
    if (event.kind === 'data') {
      storedCallbacks.onData?.(event.data)
      ack(event.data.length)
      return
    }
    if (event.kind === 'reconnecting' || event.kind === 'reconnected') {
      // The logical session continues; only the ssh2 channel behind it was swapped. Present the
      // swap as transport-internal recovery, never as a PTY exit/rebind.
      reconnecting = event.kind === 'reconnecting'
      recoveryEpoch += 1
      if (event.kind === 'reconnecting') {
        storedCallbacks.onDisconnect?.()
      } else {
        storedCallbacks.onStreamRecovered?.()
      }
      return
    }
    // Remote exit ends the session; the pane's exit handling owns the surfaced outcome.
    const code = event.exitCode
    const callbacks = storedCallbacks
    teardown(false)
    callbacks.onExit?.(code)
    transportOptions.onPtyExit?.(toDirectSshPtyId(event.sessionId), code)
  }

  const teardown = (closeSession: boolean): void => {
    unsubscribe?.()
    unsubscribe = null
    const raw = rawSessionId()
    connected = false
    sessionId = null
    reconnecting = false
    pausedUnackedChars = 0
    pendingOpenEvents = []
    storedCallbacks = {}
    // `closeSession` separates explicit user close from remount/parking/reload: a detached
    // session stays alive in main so this window (or a reopened one) can adopt it again.
    if (closeSession && raw && !destroyed) {
      try {
        api().close({ sessionId: raw })
      } catch {
        // Already gone (target teardown, quit drain) — nothing left to release.
      }
    }
  }

  const open = async (
    request: { sessionId: string } | { newSession: true },
    connectOptions: {
      callbacks: DirectSshCallbacks
      cols?: number
      rows?: number
      shouldContinue?: () => boolean
    }
  ): Promise<PtyConnectResult> => {
    // Store before any await so callbacks are live the moment onEvent subscribes.
    storedCallbacks = connectOptions.callbacks
    const bridge = api()
    const generation = ++openGeneration
    unsubscribe ??= bridge.onEvent(handleEvent)
    const result = await bridge.open({
      targetId,
      cols: connectOptions.cols && connectOptions.cols > 0 ? connectOptions.cols : 80,
      rows: connectOptions.rows && connectOptions.rows > 0 ? connectOptions.rows : 24,
      ...(transportOptions.tabId ? { tabId: transportOptions.tabId } : {}),
      ...(transportOptions.leafId ? { leafId: transportOptions.leafId } : {}),
      ...request
    })
    if (!result.ok) {
      pendingOpenEvents = []
      unsubscribe?.()
      unsubscribe = null
      // `cancelled` names a dead logical session: the reattach flow clears the stale binding and
      // starts a fresh shell. Other reasons (not-connected, already-open) surface as errors
      // without respawning, so a dropped host cannot churn replacement shells in a loop.
      throw new Error(directOpenFailureMessage(result.reason))
    }
    if (
      destroyed ||
      generation !== openGeneration ||
      (connectOptions.shouldContinue && !connectOptions.shouldContinue())
    ) {
      bridge.close({ sessionId: result.sessionId })
      throw new Error('Direct SSH pane was replaced before it connected.')
    }
    sessionId = toDirectSshPtyId(result.sessionId)
    connected = true
    reconnecting = false
    pausedUnackedChars = 0
    recoveryEpoch += 1
    const queuedEvents = pendingOpenEvents.splice(0)
    for (const event of queuedEvents) {
      handleEvent(event)
    }
    storedCallbacks.onConnect?.()
    transportOptions.onPtySpawn?.(sessionId)
    return { id: sessionId, isReattach: 'sessionId' in request }
  }

  return {
    connect: (connectOptions) => {
      const requested =
        connectOptions.sessionId !== undefined && connectOptions.sessionId !== null
          ? parseDirectSshPtyId(connectOptions.sessionId)
          : null
      if (connectOptions.sessionId != null && !requested) {
        // A malformed stored binding must fall into the fresh-shell path, not look like a live id.
        storedCallbacks = connectOptions.callbacks
        return Promise.reject(new Error('This direct SSH session has ended.'))
      }
      return open(requested ? { sessionId: requested } : { newSession: true }, {
        callbacks: connectOptions.callbacks,
        cols: connectOptions.cols,
        rows: connectOptions.rows,
        shouldContinue: connectOptions.shouldContinue
      })
    },

    attach: (attachOptions) => {
      const raw = parseDirectSshPtyId(attachOptions.existingPtyId)
      storedCallbacks = attachOptions.callbacks
      if (!raw) {
        storedCallbacks.onError?.('Not a direct SSH session id.')
        return
      }
      void open(
        { sessionId: raw },
        { callbacks: attachOptions.callbacks, cols: attachOptions.cols, rows: attachOptions.rows }
      ).catch((err: unknown) => {
        if (!destroyed) {
          storedCallbacks.onError?.(err instanceof Error ? err.message : String(err))
        }
      })
    },

    disconnect() {
      // Explicit close only: a teardown that means "remount/adopt later" goes through detach.
      openGeneration += 1
      teardown(true)
    },

    detach() {
      openGeneration += 1
      teardown(false)
    },

    destroy() {
      openGeneration += 1
      teardown(true)
      destroyed = true
    },

    sendInput(data: string, _inputKind: TerminalInputKind): boolean {
      const raw = rawSessionId()
      if (!connected || !raw) {
        return false
      }
      try {
        api().write({ sessionId: raw, data })
        return true
      } catch {
        return false
      }
    },

    sendInputImmediate(data: string): boolean {
      return this.sendInput(data, 'query-reply')
    },

    resize(cols, rows) {
      const raw = rawSessionId()
      if (connected && raw) {
        try {
          api().resize({ sessionId: raw, cols, rows })
        } catch {
          // A dropped transport resizes on its reconnect channel swap.
        }
      }
      return true
    },

    isConnected: () => connected,

    isConnectPending: () => !destroyed && !connected && sessionId === null,

    getRecoveryState: (): PtyTransportRecoveryState => ({
      phase: destroyed
        ? 'disposed'
        : !connected
          ? 'disconnected'
          : reconnecting
            ? 'recovering'
            : 'connected',
      epoch: recoveryEpoch,
      attempt: 0
    }),

    // Why: recovery belongs to this transport (main swaps channels on reconnect), so an
    // input-undeliverable probe must never race a pane remount against that reconnect.
    ownsRecovery: () => true,

    hasUndeliveredInput: () => false,

    setOutputPaused: (paused: boolean): boolean => {
      if (outputPaused === paused) {
        return false
      }
      outputPaused = paused
      if (!paused && pausedUnackedChars > 0) {
        const raw = rawSessionId()
        if (raw) {
          try {
            api().ack({ sessionId: raw, chars: pausedUnackedChars })
          } catch {
            // Teardown owns cleanup; the count resets there anyway.
          }
        }
        pausedUnackedChars = 0
      }
      return true
    },

    getPtyId: () => sessionId,

    getConnectionId: () => targetId,

    getExecutionHostId: (): ExecutionHostId | null => toSshExecutionHostId(targetId),

    // Direct hosts expose their platform through the SSH broadcast, not a per-pane record;
    // null keeps shell-agnostic behavior instead of guessing this client's OS.
    getRemotePlatform: () => null,

    getLocalSessionMetadata: () => null,

    preserve: () => {},

    notifyErrorSurfaceDismissed: () => {}
  }
}

function directOpenFailureMessage(
  reason: Extract<PlainSshTerminalOpenResult, { ok: false }>['reason']
): string {
  switch (reason) {
    case 'unknown-target':
      return 'This SSH host is no longer saved in Orca.'
    case 'not-blocked':
      return 'Orca can reach this host again, so use its terminals instead.'
    case 'already-open':
      return 'Another Orca window already owns this host’s terminals.'
    case 'not-connected':
      return 'This host is not connected. Reconnect it from Settings.'
    case 'cancelled':
      return 'This direct SSH session has ended.'
    case 'ssh-missing':
    case 'spawn-failed':
      return 'Could not open a shell on the host.'
    default:
      return 'Could not open a shell on the host.'
  }
}
