/** Wires one ssh2 shell channel to a terminal session: UTF-8 stream decode, the exit verdict,
 * backpressure, and the reconnect-vs-dead classification when the channel drops. */
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import type { PlainSshTerminalEvent } from '../../../shared/plain-ssh-terminal'
import {
  DROPPED_EXIT_CODE,
  PAUSE_ABOVE_UNACKED,
  SIGNALLED_EXIT_CODE,
  type TerminalSession
} from './direct-ssh-terminal-session-record'

/** The channel layer's view of the registry that owns sessions. */
export type ChannelSessionHost = {
  transportHealthy: (targetId: string) => boolean
  emit: (session: TerminalSession, event: PlainSshTerminalEvent) => boolean
  remove: (session: TerminalSession, exitCode?: number) => void
}

export function wireSessionChannel(
  session: TerminalSession,
  channel: ClientChannel,
  host: ChannelSessionHost
): void {
  const stdout = new StringDecoder('utf8')
  channel.on('data', (chunk: Buffer) => onData(session, channel, host, stdout.write(chunk)))
  channel.on('exit', (code: number | null) => {
    if (session.channel === channel) {
      session.exitCode = typeof code === 'number' ? code : SIGNALLED_EXIT_CODE
    }
  })
  // Channel errors surface as close; the close handler owns the verdict.
  channel.on('error', () => {})
  channel.on('close', () => onChannelClose(session, channel, host))
}

function onData(
  session: TerminalSession,
  channel: ClientChannel,
  host: ChannelSessionHost,
  data: string
): void {
  if (session.channel !== channel || !data) {
    return
  }
  if (!host.emit(session, { kind: 'data', sessionId: session.id, data })) {
    host.remove(session)
    return
  }
  session.unacked += data.length
  if (!session.paused && session.unacked > PAUSE_ABOVE_UNACKED) {
    session.paused = true
    channel.pause()
  }
}

function onChannelClose(
  session: TerminalSession,
  channel: ClientChannel,
  host: ChannelSessionHost
): void {
  if (session.channel !== channel) {
    return
  }
  session.channel = null
  if (session.exitCode !== null) {
    // The remote shell reported its own end; a zero code is a clean logout.
    host.remove(session, session.exitCode)
    return
  }
  if (host.transportHealthy(session.targetId)) {
    // The transport is healthy, so the shell died without reporting an exit.
    host.remove(session, DROPPED_EXIT_CODE)
    return
  }
  session.state = 'reattaching'
  host.emit(session, { kind: 'reconnecting', sessionId: session.id })
}
