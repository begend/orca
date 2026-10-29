import { toDirectSshPtyId } from '../../../shared/direct-ssh-pty-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

export type DirectSshAdoptableSession = {
  sessionId: string
  tabId?: string
  leafId?: string
  cols: number
  rows: number
}

/** Pair detached logical sessions with their exact canonical leaves. */
export function reconcileDirectSshLayoutBindings(
  layout: TerminalLayoutSnapshot,
  sessions: readonly DirectSshAdoptableSession[],
  tabId?: string
): TerminalLayoutSnapshot {
  const leafIds = collectLeafIds(layout.root)
  if (leafIds.length === 0 || sessions.length === 0) {
    return layout
  }
  const existing = layout.ptyIdsByLeafId ?? {}
  const used = new Set(Object.values(existing))
  const remaining = sessions.filter((session) => !used.has(toDirectSshPtyId(session.sessionId)))
  const ptyIdsByLeafId = { ...existing }
  let changed = false

  for (const leafId of leafIds) {
    if (ptyIdsByLeafId[leafId]) {
      continue
    }
    const sessionIndex = remaining.findIndex(
      (session) => session.tabId === tabId && session.leafId === leafId
    )
    if (sessionIndex === -1) {
      continue
    }
    const [session] = remaining.splice(sessionIndex, 1)
    if (!session) {
      break
    }
    ptyIdsByLeafId[leafId] = toDirectSshPtyId(session.sessionId)
    changed = true
  }

  return changed ? { ...layout, ptyIdsByLeafId } : layout
}

export async function reconcileDirectSshSessionsInStore(state: {
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot) => void
}): Promise<void> {
  const api = window.api.plainSsh
  if (!api) {
    return
  }
  const byTarget = new Map<string, TerminalTab[]>()
  for (const tab of Object.values(state.tabsByWorktree).flat()) {
    if (!tab.directSsh) {
      continue
    }
    const tabs = byTarget.get(tab.directSsh.targetId) ?? []
    tabs.push(tab)
    byTarget.set(tab.directSsh.targetId, tabs)
  }
  await Promise.all(
    [...byTarget].map(async ([targetId, tabs]) => {
      const listed = await api.list({ targetId }).catch(() => ({ sessions: [] }))
      let remaining = listed.sessions
      for (const tab of tabs.sort((a, b) => a.createdAt - b.createdAt)) {
        const layout = state.terminalLayoutsByTabId[tab.id]
        if (!layout) {
          continue
        }
        const reconciled = reconcileDirectSshLayoutBindings(layout, remaining, tab.id)
        if (reconciled !== layout) {
          state.setTabLayout(tab.id, reconciled)
          const adopted = new Set(Object.values(reconciled.ptyIdsByLeafId ?? {}))
          remaining = remaining.filter(
            (session) => !adopted.has(toDirectSshPtyId(session.sessionId))
          )
        }
      }
    })
  )
}

function collectLeafIds(root: TerminalLayoutSnapshot['root']): string[] {
  if (!root) {
    return []
  }
  return root.type === 'leaf'
    ? [root.leafId]
    : [...collectLeafIds(root.first), ...collectLeafIds(root.second)]
}
