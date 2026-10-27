// Keep one plain SSH window per host outside store/session; never persist, restore or sync it.
import { useSyncExternalStore } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'

/** A terminal tab inside a direct host's window; `attachSessionId` reattaches a listed session. */
export type PlainSshPanelTab = {
  id: string
  attachSessionId?: string
  customTitle?: string
}

/** Id of the pseudo-tab that shows the host's SFTP file browser. */
export const PLAIN_SSH_FILES_TAB_ID = 'files'

export type PlainSshPanel = {
  targetId: string
  label: string
  minimized: boolean
  /** Direct hosts get terminal tabs plus a Files tab backed by SFTP; the escape hatch stays terminal-only. */
  direct: boolean
  /** Direct hosts only; ordered terminal tabs, one shell each. */
  tabs: PlainSshPanelTab[]
  /** Selected terminal tab id, the Files pseudo-tab id, or null (nothing selected yet). */
  selectedTabId: string | null
}

let panels: readonly PlainSshPanel[] = []
const listeners = new Set<() => void>()

function publish(next: readonly PlainSshPanel[]): void {
  panels = next
  for (const listener of listeners) {
    listener()
  }
}

function patchPanel(targetId: string, patch: (panel: PlainSshPanel) => PlainSshPanel): void {
  publish(panels.map((panel) => (panel.targetId === targetId ? patch(panel) : panel)))
}

/** Shows the host's window, opening it if needed; only one is expanded at a time. */
export function showPlainSshPanel(
  targetId: string,
  label: string,
  options?: { direct?: boolean }
): void {
  const direct = options?.direct ?? false
  const rest = panels
    .filter((panel) => panel.targetId !== targetId)
    .map((panel) => (panel.minimized ? panel : { ...panel, minimized: true }))
  const current = panels.find((panel) => panel.targetId === targetId)
  publish([
    ...rest,
    current
      ? { ...current, minimized: false, label, direct: current.direct || direct }
      : {
          targetId,
          label,
          minimized: false,
          direct,
          tabs: [],
          // Direct windows populate tabs from the session list once mounted.
          selectedTabId: null
        }
  ])
  if (direct) {
    const state = useAppStore.getState()
    if (state.activeView !== 'terminal') {
      state.setActiveView('terminal')
    }
  }
}

/** Adds a terminal tab and selects it; returns the tab id. */
export function addPlainSshPanelTab(
  targetId: string,
  options?: { attachSessionId?: string }
): string {
  const tab: PlainSshPanelTab = { id: createBrowserUuid(), ...options }
  patchPanel(targetId, (panel) => ({
    ...panel,
    tabs: [...panel.tabs, tab],
    selectedTabId: tab.id
  }))
  return tab.id
}

export function closePlainSshPanelTab(targetId: string, tabId: string): void {
  patchPanel(targetId, (panel) => {
    const index = panel.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) {
      return panel
    }
    const tabs = panel.tabs.filter((tab) => tab.id !== tabId)
    let selectedTabId = panel.selectedTabId
    if (selectedTabId === tabId) {
      // Next tab right, else left, else the Files pseudo-tab.
      selectedTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? PLAIN_SSH_FILES_TAB_ID
    }
    return { ...panel, tabs, selectedTabId }
  })
}

export function setActivePlainSshPanelTab(targetId: string, tabId: string): void {
  publish(
    panels.map((panel) => {
      if (panel.targetId === targetId) {
        return {
          ...panel,
          minimized: false,
          selectedTabId: tabId
        }
      }
      return panel.minimized ? panel : { ...panel, minimized: true }
    })
  )
}

export function setPlainSshPanelTabTitle(
  targetId: string,
  tabId: string,
  customTitle: string | null
): void {
  patchPanel(targetId, (panel) => ({
    ...panel,
    tabs: panel.tabs.map((tab) =>
      tab.id === tabId
        ? { ...tab, ...(customTitle ? { customTitle } : { customTitle: undefined }) }
        : tab
    )
  }))
}

export function minimizePlainSshPanels(): void {
  publish(panels.map((panel) => (panel.minimized ? panel : { ...panel, minimized: true })))
}

export function minimizePlainSshPanel(targetId: string): void {
  patchPanel(targetId, (panel) => ({ ...panel, minimized: true }))
}

export function removePlainSshPanel(targetId: string): void {
  publish(panels.filter((panel) => panel.targetId !== targetId))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Synchronous read for effects that must dedup against tabs added after their render. */
export function getPlainSshPanel(targetId: string): PlainSshPanel | undefined {
  return panels.find((panel) => panel.targetId === targetId)
}

export function usePlainSshPanels(): readonly PlainSshPanel[] {
  return useSyncExternalStore(subscribe, () => panels)
}
