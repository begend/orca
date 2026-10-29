import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

/** Derive only provider/relay reconnect data. Direct SSH owns process-local sessions elsewhere. */
export function buildTerminalSessionData(
  snapshot: WorkspaceSessionSnapshot
): Pick<WorkspaceSessionState, 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'> {
  const { tabsByWorktree, ptyIdsByTabId } = snapshot
  // Use live bindings rather than row.ptyId, which sleeping panes retain only as a wake hint.
  const hasLivePty = (tabId: string): boolean => (ptyIdsByTabId[tabId]?.length ?? 0) > 0
  // Relay reconnect clears row.ptyId while these maps keep its durable provider handle.
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId
  const pendingReconnect = snapshot.pendingReconnectPtyIdByTabId ?? {}
  const deferredSshSessions = snapshot.deferredSshSessionIdsByTabId ?? {}
  const restoredSessionId = (tabId: string): string | undefined =>
    lastKnown[tabId] || pendingReconnect[tabId] || deferredSshSessions[tabId]
  const hasReconnectableSession = (tab: {
    id: string
    ptyId: string | null
    directSsh?: unknown
  }): boolean =>
    !tab.directSsh && (hasLivePty(tab.id) || (!tab.ptyId && Boolean(restoredSessionId(tab.id))))

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some(hasReconnectableSession))
    .map(([worktreeId]) => worktreeId)
  const worktreeById = new Map(
    Object.values(snapshot.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
  const repoById = new Map(snapshot.repos.map((repo) => [repo.id, repo]))
  // Preindex ownership locally: synchronous IPC/catalog rescans are fragile during shutdown.
  const remoteSessionIdsByTabId: Record<string, string> = {}

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const worktree = worktreeById.get(worktreeId)
    const repo = worktree ? repoById.get(worktree.repoId) : null
    if (!repo?.connectionId) {
      continue
    }
    for (const tab of tabs) {
      if (!hasReconnectableSession(tab)) {
        continue
      }
      const sessionId = tab.ptyId || restoredSessionId(tab.id)
      if (sessionId) {
        remoteSessionIdsByTabId[tab.id] = sessionId
      }
    }
  }

  return {
    activeWorktreeIdsOnShutdown,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined
  }
}
