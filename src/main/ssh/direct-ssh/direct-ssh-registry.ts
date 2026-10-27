/** Lazy holders for the app-wide Direct SSH terminal sessions and file service, so IPC wiring,
 * the connection state callback and teardown can share instances without module cycles. */
import type { DirectSshFileService } from './direct-ssh-file-service'
import type { DirectSshTerminalSessions } from './direct-ssh-terminal-sessions'

let sessions: DirectSshTerminalSessions | null = null
let files: DirectSshFileService | null = null

export function setDirectSshTerminalSessions(next: DirectSshTerminalSessions | null): void {
  sessions = next
}

export function getDirectSshTerminalSessions(): DirectSshTerminalSessions | null {
  return sessions
}

export function setDirectSshFileService(next: DirectSshFileService | null): void {
  files = next
}

export function getDirectSshFileService(): DirectSshFileService | null {
  return files
}
