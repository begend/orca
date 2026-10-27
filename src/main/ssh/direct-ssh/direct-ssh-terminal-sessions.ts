/** FinalShell-style long-lived terminals on a manually-added host's ssh2 transport. One logical
 * session per target survives transport drops: main keeps the session, swaps in a fresh shell
 * channel after the connection reconnects, and only a remote exit, explicit close or teardown
 * ends it. Unlike the system-ssh escape hatch these sessions are not owner-bound, so a window
 * reload detaches instead of hanging up. */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel, PseudoTtyOptions, ShellOptions } from 'ssh2'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../shared/plain-ssh-terminal'

export type DirectSshConnectionLike = {
  shell: (pty: PseudoTtyOptions, options?: ShellOptions) => Promise<ClientChannel>
  getState: () => SshConnectionState
  isDisposed: () => boolean
}

export type DirectSshTerminalDeps = {
  getConnection: (targetId: string) => DirectSshConnectionLike | undefined
  isOwnerLive: (owner: number) => boolean
}

type PlainSshTerminalSink = (event: PlainSshTerminalEvent) => boolean

/** Label-free open result; the caller (which knows the target) attaches `label`. */
export type DirectSshTerminalOpenResult =
  | { ok: true; sessionId: string }
  | Extract<PlainSshTerminalOpenResult, { ok: false }>

type TerminalSession = {
  id: string
  targetId: string
  owner: number | null
  sink: PlainSshTerminalSink | null
  channel: ClientChannel | null
  state: 'opening' | 'live' | 'reattaching'
  cols: number
  rows: number
  exitCode: number | null
  /** Output sent but not yet rendered by the attached window, in UTF-16 units. */
  unacked: number
  paused: boolean
}

const TERM = 'xterm-256color'
// Why: sshd reports a signalled shell as exit-signal, not exit-status; mirror the shell's 128+n.
const SIGNALLED_EXIT_CODE = 129
/** ssh's own convention for a dropped connection; also used when teardown ends a session. */
const DROPPED_EXIT_CODE = 255
// Backpressure large output until rendered instead of accumulating unbounded IPC.
const PAUSE_ABOVE_UNACKED = 512 * 1024
const RESUME_BELOW_UNACKED = 128 * 1024
const MIN_SIZE = 2
const MAX_SIZE = 1_000

export class DirectSshTerminalSessions {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly byTarget = new Map<string, TerminalSession>()

  constructor(private readonly deps: DirectSshTerminalDeps) {}

  async open(
    targetId: string,
    owner: number,
    request: { cols: unknown; rows: unknown },
    sink: PlainSshTerminalSink
  ): Promise<DirectSshTerminalOpenResult> {
    const connection = this.deps.getConnection(targetId)
    if (!connection || connection.isDisposed()) {
      return { ok: false, reason: 'not-connected' }
    }
    const existing = this.byTarget.get(targetId)
    if (existing) {
      if (
        existing.owner !== null &&
        existing.owner !== owner &&
        this.deps.isOwnerLive(existing.owner)
      ) {
        return { ok: false, reason: 'already-open' }
      }
      this.attach(existing, owner, sink)
      return { ok: true, sessionId: existing.id }
    }
    const session: TerminalSession = {
      id: randomUUID(),
      targetId,
      owner,
      sink,
      channel: null,
      state: 'opening',
      cols: clampSize(request.cols, 80),
      rows: clampSize(request.rows, 24),
      exitCode: null,
      unacked: 0,
      paused: false
    }
    this.sessions.set(session.id, session)
    this.byTarget.set(targetId, session)
    if (connection.getState().status === 'connected') {
      try {
        await this.openChannel(session, connection)
      } catch (error) {
        this.remove(session)
        return {
          ok: false,
          reason: 'spawn-failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    } else {
      // The transport is mid-reconnect; the session reattaches on the next connected broadcast.
      session.state = 'reattaching'
      this.emit(session, { kind: 'reconnecting', sessionId: session.id })
    }
    return { ok: true, sessionId: session.id }
  }

  write(sessionId: unknown, owner: number, data: unknown): void {
    const session = this.ownedSession(sessionId, owner)
    if (session && typeof data === 'string' && session.state === 'live') {
      session.channel?.write(data)
    }
  }

  resize(sessionId: unknown, owner: number, cols: unknown, rows: unknown): void {
    const session = this.ownedSession(sessionId, owner)
    if (!session) {
      return
    }
    session.cols = clampSize(cols, session.cols)
    session.rows = clampSize(rows, session.rows)
    if (session.state === 'live') {
      session.channel?.setWindow(session.rows, session.cols, 0, 0)
    }
  }

  ack(sessionId: unknown, owner: number, chars: unknown): void {
    const session = this.ownedSession(sessionId, owner)
    if (
      !session ||
      typeof chars !== 'number' ||
      !Number.isFinite(chars) ||
      chars <= 0 ||
      !session.paused
    ) {
      return
    }
    session.unacked = Math.max(0, session.unacked - chars)
    if (session.unacked < RESUME_BELOW_UNACKED) {
      session.paused = false
      session.channel?.resume()
    }
  }

  close(sessionId: unknown, owner: number): void {
    const session = this.ownedSession(sessionId, owner)
    if (session) {
      this.remove(session)
    }
  }

  /** Window reload, crash or close: detach so the session outlives the renderer that opened it. */
  detachOwner(owner: number): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) {
        session.owner = null
        session.sink = null
      }
    }
  }

  notifyConnectionState(targetId: string, status: SshConnectionState['status']): void {
    const session = this.byTarget.get(targetId)
    if (!session || session.state === 'opening') {
      return
    }
    if (status === 'connected' && session.state === 'reattaching') {
      void this.reattach(session)
    }
  }

  /** Teardown (user Disconnect, target removal): end the session and report the drop. */
  closeForTarget(targetId: string): void {
    const session = this.byTarget.get(targetId)
    if (session) {
      this.remove(session, DROPPED_EXIT_CODE)
    }
  }

  closeAll(): void {
    // Map iteration tolerates deletion of the current entry, so no copy is needed.
    for (const session of this.sessions.values()) {
      this.remove(session)
    }
  }

  private attach(session: TerminalSession, owner: number, sink: PlainSshTerminalSink): void {
    session.owner = owner
    session.sink = sink
    session.unacked = 0
    if (session.paused) {
      session.paused = false
      session.channel?.resume()
    }
    if (session.state === 'reattaching') {
      this.emit(session, { kind: 'reconnecting', sessionId: session.id })
    }
  }

  private async openChannel(
    session: TerminalSession,
    connection: DirectSshConnectionLike
  ): Promise<void> {
    const channel = await connection.shell({
      cols: session.cols,
      rows: session.rows,
      term: TERM
    })
    // A reconnect, teardown or replacement channel may have won the race while the shell opened.
    if (this.sessions.get(session.id) !== session || session.channel !== null) {
      channel.close()
      return
    }
    session.channel = channel
    session.state = 'live'
    this.wireChannel(session, channel)
  }

  private wireChannel(session: TerminalSession, channel: ClientChannel): void {
    const stdout = new StringDecoder('utf8')
    channel.on('data', (chunk: Buffer) => this.onData(session, channel, stdout.write(chunk)))
    channel.on('exit', (code: number | null) => {
      if (session.channel === channel) {
        session.exitCode = typeof code === 'number' ? code : SIGNALLED_EXIT_CODE
      }
    })
    // Channel errors surface as close; the close handler owns the verdict.
    channel.on('error', () => {})
    channel.on('close', () => this.onChannelClose(session, channel))
  }

  private onData(session: TerminalSession, channel: ClientChannel, data: string): void {
    if (session.channel !== channel || !data) {
      return
    }
    if (!this.emit(session, { kind: 'data', sessionId: session.id, data })) {
      this.remove(session)
      return
    }
    session.unacked += data.length
    if (!session.paused && session.unacked > PAUSE_ABOVE_UNACKED) {
      session.paused = true
      channel.pause()
    }
  }

  private onChannelClose(session: TerminalSession, channel: ClientChannel): void {
    if (session.channel !== channel) {
      return
    }
    session.channel = null
    if (session.exitCode !== null) {
      // The remote shell reported its own end; a zero code is a clean logout.
      this.remove(session, session.exitCode)
      return
    }
    if (this.deps.getConnection(session.targetId)?.getState().status === 'connected') {
      // The transport is healthy, so the shell died without reporting an exit.
      this.remove(session, DROPPED_EXIT_CODE)
      return
    }
    session.state = 'reattaching'
    this.emit(session, { kind: 'reconnecting', sessionId: session.id })
  }

  private async reattach(session: TerminalSession): Promise<void> {
    const connection = this.deps.getConnection(session.targetId)
    if (!connection || connection.isDisposed()) {
      return
    }
    session.state = 'opening'
    session.exitCode = null
    try {
      await this.openChannel(session, connection)
    } catch {
      // The next connected broadcast retries; meanwhile the session stays detached from output.
      if (this.sessions.get(session.id) === session) {
        session.state = 'reattaching'
      }
      return
    }
    if (this.sessions.get(session.id) !== session) {
      return
    }
    this.emit(session, { kind: 'reconnected', sessionId: session.id })
  }

  private remove(session: TerminalSession, exitCode?: number): void {
    if (this.sessions.get(session.id) !== session) {
      return
    }
    this.sessions.delete(session.id)
    if (this.byTarget.get(session.targetId) === session) {
      this.byTarget.delete(session.targetId)
    }
    const channel = session.channel
    session.channel = null
    try {
      channel?.close()
    } catch {
      // The transport is already gone; nothing left to release.
    }
    if (exitCode !== undefined) {
      this.emit(session, { kind: 'exit', sessionId: session.id, exitCode })
    }
  }

  private emit(session: TerminalSession, event: PlainSshTerminalEvent): boolean {
    const sink = session.sink
    return sink ? sink(event) : true
  }

  private ownedSession(sessionId: unknown, owner: number): TerminalSession | null {
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    return session && session.owner === owner ? session : null
  }
}

function clampSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(value)))
    : fallback
}
