import { isDirectSshPtyId } from './direct-ssh-pty-id'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'

/** Direct logical sessions survive renderer reloads in live state, but main destroys them at app quit.
 * Keep the target descriptor durable while removing process-local logical IDs at disk boundaries. */
export function withoutPersistedDirectSshTabBinding(tab: TerminalTab): TerminalTab {
  return tab.directSsh && isDirectSshPtyId(tab.ptyId) ? { ...tab, ptyId: null } : tab
}

/** Remove only direct logical bindings. Ordinary daemon/relay PTY IDs remain restart inputs. */
export function withoutPersistedDirectSshLayoutBindings(
  layout: TerminalLayoutSnapshot,
  directSsh: TerminalTab['directSsh']
): TerminalLayoutSnapshot {
  if (!directSsh || !layout.ptyIdsByLeafId) {
    return layout
  }
  const ptyIdsByLeafId = Object.fromEntries(
    Object.entries(layout.ptyIdsByLeafId).filter(([, ptyId]) => !isDirectSshPtyId(ptyId))
  )
  const persistedCount = Object.keys(ptyIdsByLeafId).length
  if (persistedCount === Object.keys(layout.ptyIdsByLeafId).length) {
    return layout
  }
  const sanitized = { ...layout }
  if (persistedCount === 0) {
    delete sanitized.ptyIdsByLeafId
  } else {
    sanitized.ptyIdsByLeafId = ptyIdsByLeafId
  }
  return sanitized
}

export function directSshDescriptorByTabId(
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>
): ReadonlyMap<string, NonNullable<TerminalTab['directSsh']>> {
  return new Map(
    Object.values(tabsByWorktree)
      .flat()
      .flatMap((tab) => (tab.directSsh ? [[tab.id, tab.directSsh] as const] : []))
  )
}

export function withoutPersistedDirectSshLayoutBindingsByTab(
  layouts: Readonly<Record<string, TerminalLayoutSnapshot>>,
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>
): Record<string, TerminalLayoutSnapshot> {
  const directSshByTabId = directSshDescriptorByTabId(tabsByWorktree)
  return Object.fromEntries(
    Object.entries(layouts).map(([tabId, layout]) => [
      tabId,
      withoutPersistedDirectSshLayoutBindings(layout, directSshByTabId.get(tabId))
    ])
  )
}
