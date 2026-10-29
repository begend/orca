import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { useAppStore } from '../store'

/** Canonical home for direct-SSH host shells. They join the active workspace's tab bar like any
 * terminal; with no workspace open they land in the floating terminal worktree. Both keep one tab
 * system: the host shell is a real TerminalTab with a direct transport descriptor, so activation,
 * rename, split, and close all flow through the standard tab model. */
export function openDirectSshTerminal(targetId: string, hostLabel: string): void {
  const state = useAppStore.getState()
  const hostWorktreeId = state.activeWorktreeId ?? FLOATING_TERMINAL_WORKTREE_ID
  // One shell set per host: reopening from Settings reactivates the existing tab instead of
  // minting a second one in whichever worktree happens to be active now.
  const existingWorktreeId =
    Object.entries(state.tabsByWorktree).find(([, tabs]) =>
      tabs.some((tab) => tab.directSsh?.targetId === targetId)
    )?.[0] ?? hostWorktreeId
  const existing = (state.tabsByWorktree[existingWorktreeId] ?? []).find(
    (tab) => tab.directSsh?.targetId === targetId
  )
  let tabId: string
  if (existing) {
    tabId = existing.id
  } else {
    // Global dedupe above means a new tab is this host's first shell; its label alone keeps it
    // distinguishable from project terminals.
    const tab = state.createTab(existingWorktreeId, undefined, undefined, {
      directSsh: { targetId },
      activate: true
    })
    tabId = tab.id
    state.setTabCustomTitle(tabId, hostLabel)
  }
  if (
    existingWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    existingWorktreeId !== state.activeWorktreeId
  ) {
    state.setActiveWorktree(existingWorktreeId)
  }
  if (existingWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    // The floating panel mounts when it owns tabs even if the toggle is off; opening it makes
    // the new shell visible immediately.
    state.setFloatingWorkspacePanelOpen(true)
  }
  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }
  state.setActiveTab(tabId)
  state.setActiveTabType('terminal', existingWorktreeId)
}
