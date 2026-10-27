/** FinalShell-style long-lived terminals on a manually-added host's ssh2 transport. Each logical
 * session (one per terminal tab) survives transport drops: main keeps the session, swaps in a
 * fresh shell channel after the connection reconnects, and only a remote exit, explicit close or
 * teardown ends it. Unlike the system-ssh escape hatch these sessions are not owner-bound, so a
 * window reload detaches instead of hanging up. */
import { randomUUID } from 'node:crypto'
import type { ClientChannel, PseudoTtyOptions, ShellOptions } from 'ssh2'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../shared/plain-ssh-terminal'
import {
  DROPPED_EXIT_CODE,
  RESUME_BELOW_UNACKED,
  TERM,
  clampSize,
  type PlainSshTerminalSink,
  type TerminalSession
} from './direct-ssh-terminal-session-record'
import { wireSessionChannel, type ChannelSessionHost } from './direct-ssh-terminal-channel'

export type DirectSshConnectionLike = {
  shell: (pty: PseudoTtyOptions, options?: ShellOptions) => Promise<ClientChannel>
  getState: () => SshConnectionState
  isDisposed: () => boolean
}

export type DirectSshTerminalDeps = {
  getConnection: (targetId: string) => DirectSshConnectionLike | undefined
  isOwnerLive: (owner: number) => boolean
}

/** Label-free open result; the caller (which knows the target) attaches `label`. */
export type DirectSshTerminalOpenResult =
  | { ok: true; sessionId: string }
  | Extract<PlainSshTerminalOpenResult, { ok: false }>

export class DirectSshTerminalSessions {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly byTarget = new Map<string, Set<string>>()
  private readonly channelHost: ChannelSessionHost = {
    transportHealthy: (targetId) =>
      this.deps.getConnection(targetId)?.getState().status === 'connected',
    emit: (session, event) => this.emit(session, event),
    remove: (session, exitCode) => this.remove(session, exitCode)
  }

  constructor(private readonly deps: DirectSshTerminalDeps) {}

  async open(
    targetId: string,
    owner: number,
    request: { cols: unknown; rows: unknown; newSession?: unknown; sessionId?: unknown },
    sink: PlainSshTerminalSink
  ): Promise<DirectSshTerminalOpenResult> {
    const connection = this.deps.getConnection(targetId)
    if (!connection || connection.isDisposed()) {
      return { ok: false, reason: 'not-connected' }
    }
    const existing = this.sessionsForTarget(targetId)
    // One live window owns a host's shells; detached ones wait for any window to adopt.
    if (
      existing.some(
        (session) =>
          session.owner !== null && session.owner !== owner && this.deps.isOwnerLive(session.owner)
      )
    ) {
      return { ok: false, reason: 'already-open' }
    }
    if (typeof request.sessionId === 'string') {
      const session = this.sessions.get(request.sessionId)
      if (!session || session.targetId !== targetId) {
        return { ok: false, reason: 'cancelled' }
      }
      this.attach(session, owner, sink, request)
      return { ok: true, sessionId: session.id }
    }
    if (request.newSession !== true) {
      const adoptable = existing.find(
        (session) => session.owner === null || session.owner === owner
      )
      if (adoptable) {
        this.attach(adoptable, owner, sink, request)
        return { ok: true, sessionId: adoptable.id }
      }
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
    this.indexTarget(session)
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

  /** True when the id names a direct session, so IPC can dispatch instead of the legacy PTY map. */
  hasSession(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && this.sessions.has(sessionId)
  }

  /** Sessions the window may see: none while another live window owns any of the host's shells. */
  listSessions(targetId: string, owner: number): string[] {
    const existing = this.sessionsForTarget(targetId)
    if (
      existing.some(
        (session) =>
          session.owner !== null && session.owner !== owner && this.deps.isOwnerLive(session.owner)
      )
    ) {
      return []
    }
    return existing.map((session) => session.id)
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
    if (!session || typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) {
      return
    }
    // Count every rendered byte or the first burst can throttle a session that never paused.
    session.unacked = Math.max(0, session.unacked - chars)
    if (session.paused && session.unacked < RESUME_BELOW_UNACKED) {
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
    if (status !== 'connected') {
      return
    }
    // Every surviving tab gets its own replacement channel under its logical session id.
    for (const session of this.sessionsForTarget(targetId)) {
      if (session.state === 'reattaching') {
        void this.reattach(session)
      }
    }
  }

  /** Teardown (user Disconnect, target removal): end the session and report the drop. */
  closeForTarget(targetId: string): void {
    for (const session of this.sessionsForTarget(targetId)) {
      this.remove(session, DROPPED_EXIT_CODE)
    }
  }

  closeAll(): void {
    // Map iteration tolerates deletion of the current entry, so no copy is needed.
    for (const session of this.sessions.values()) {
      this.remove(session)
    }
  }

  private sessionsForTarget(targetId: string): TerminalSession[] {
    const ids = this.byTarget.get(targetId)
    if (!ids) {
      return []
    }
    const sessions: TerminalSession[] = []
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (session) {
        sessions.push(session)
      }
    }
    return sessions
  }

  private indexTarget(session: TerminalSession): void {
    const ids = this.byTarget.get(session.targetId)
    if (ids) {
      ids.add(session.id)
    } else {
      this.byTarget.set(session.targetId, new Set([session.id]))
    }
  }

  private attach(
    session: TerminalSession,
    owner: number,
    sink: PlainSshTerminalSink,
    request: { cols: unknown; rows: unknown }
  ): void {
    session.owner = owner
    session.sink = sink
    session.unacked = 0
    // The attaching xterm measures its own grid; a detached session must follow it.
    session.cols = clampSize(request.cols, session.cols)
    session.rows = clampSize(request.rows, session.rows)
    if (session.state === 'live') {
      session.channel?.setWindow(session.rows, session.cols, 0, 0)
    }
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
    wireSessionChannel(session, channel, this.channelHost)
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
    const ids = this.byTarget.get(session.targetId)
    if (ids) {
      ids.delete(session.id)
      if (ids.size === 0) {
        this.byTarget.delete(session.targetId)
      }
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
