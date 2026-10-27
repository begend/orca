/** The terminal-session record shared by the registry (direct-ssh-terminal-sessions.ts) and its
 * shell channels, plus the lifecycle thresholds both sides enforce. */
import type { ClientChannel } from 'ssh2'
import type { PlainSshTerminalEvent } from '../../../shared/plain-ssh-terminal'

export type PlainSshTerminalSink = (event: PlainSshTerminalEvent) => boolean

export type TerminalSession = {
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

export const TERM = 'xterm-256color'
// Why: sshd reports a signalled shell as exit-signal, not exit-status; mirror the shell's 128+n.
export const SIGNALLED_EXIT_CODE = 129
/** ssh's own convention for a dropped connection; also used when teardown ends a session. */
export const DROPPED_EXIT_CODE = 255
// Backpressure large output until rendered instead of accumulating unbounded IPC.
export const PAUSE_ABOVE_UNACKED = 512 * 1024
export const RESUME_BELOW_UNACKED = 128 * 1024

const MIN_SIZE = 2
const MAX_SIZE = 1_000

export function clampSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(value)))
    : fallback
}
