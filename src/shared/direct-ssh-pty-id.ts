/** Direct-SSH terminals bind panes by a namespaced logical session id so every existing
 * ptyId-shaped consumer (leaf layout bindings, ptyIdsByTabId, reattach choice) keeps working
 * without routing the id to the daemon PTY provider. Unminted (no `@@`) ids are already
 * treated as ownerless by `isPtySessionIdOwnedByWorktree`, so reattach choice adopts them. */
export const DIRECT_SSH_PTY_ID_PREFIX = 'direct-ssh:'

export function toDirectSshPtyId(sessionId: string): string {
  return `${DIRECT_SSH_PTY_ID_PREFIX}${sessionId}`
}

/** Returns the logical direct session id, or null for non-direct pty ids. */
export function parseDirectSshPtyId(ptyId: string | null | undefined): string | null {
  if (!ptyId || !ptyId.startsWith(DIRECT_SSH_PTY_ID_PREFIX)) {
    return null
  }
  const sessionId = ptyId.slice(DIRECT_SSH_PTY_ID_PREFIX.length)
  return sessionId.length > 0 ? sessionId : null
}

export function isDirectSshPtyId(ptyId: string | null | undefined): boolean {
  return parseDirectSshPtyId(ptyId) !== null
}
