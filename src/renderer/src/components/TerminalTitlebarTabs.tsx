import { createPortal } from 'react-dom'
import { useLayoutEffect, useState } from 'react'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '../store'
import TabBar from './tab-bar/TabBar'
import type { TerminalController } from './use-terminal-controller'
import { minimizePlainSshPanels, usePlainSshPanels } from '@/ssh/plain-ssh-terminal-panels'
import { PlainSshTabItems } from './plain-ssh-terminal/PlainSshTabItems'

const EMPTY_TERMINAL_TABS: TerminalTab[] = []

// Isolate title subscriptions so renames do not rerender the topology-owning Terminal root.
function LiveTerminalTabBar(
  props: Omit<React.ComponentProps<typeof TabBar>, 'tabs'>
): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabsByWorktree[props.worktreeId] ?? EMPTY_TERMINAL_TABS)
  return <TabBar {...props} tabs={tabs} />
}

export function TerminalTitlebarTabs({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const panels = usePlainSshPanels()
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const target = document.getElementById('titlebar-tabs')
    setPortalTarget(target)
    if (!target || typeof MutationObserver === 'undefined') {
      return
    }
    const observer = new MutationObserver(() => {
      setPortalTarget(document.getElementById('titlebar-tabs'))
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const {
    activeBrowserTabId,
    activeFileId,
    activeTabId,
    activeTabType,
    effectiveActiveLayout,
    expandedPaneByTabId,
    handleActivateBrowserTab,
    handleActivateTab,
    handleCloseAllFiles,
    handleCloseBrowserTab,
    handleCloseFile,
    handleCloseOthers,
    handleCloseTab,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleDuplicateBrowserTab,
    handleNewBrowserTab,
    handleNewFile,
    handleNewSimulatorTab,
    handleNewTab,
    handleOpenEntry,
    handleTogglePaneExpand,
    makePreviewFilePermanent,
    mobileEmulatorEnabled,
    pinFile,
    renderedActiveWorktreeId,
    setActiveFile,
    setActiveTab,
    setActiveTabType,
    setTabColor,
    setTabCustomTitle,
    tabBarOrder,
    titlebarTabsTarget,
    worktreeBrowserTabs,
    worktreeClientHostedBrowserRows,
    worktreeFiles
  } = controller
  const activePanel = panels.find((panel) => panel.direct && !panel.minimized)
  // In split layouts the per-group strips own the tabs, but an active direct-SSH surface covers
  // them; the unified titlebar bar must take over so workspace and SSH tabs stay reachable.
  const resolvedTitlebarTabsTarget = portalTarget ?? titlebarTabsTarget
  if (!resolvedTitlebarTabsTarget || (effectiveActiveLayout && !activePanel)) {
    return null
  }
  // Minimized panels keep their tabs clickable here so they can be restored; none reads active.
  const stripPanel = panels.find((panel) => panel.direct)
  const activateWorkspaceTab = (tabId: string): void => {
    minimizePlainSshPanels()
    handleActivateTab(tabId)
  }
  const plainItems = stripPanel ? <PlainSshTabItems panel={stripPanel} /> : null
  if (!renderedActiveWorktreeId) {
    if (!stripPanel) {
      return null
    }
    return createPortal(
      <div
        className="flex h-full min-w-0 items-stretch overflow-hidden border-r border-border/70"
        role="tablist"
      >
        {plainItems}
      </div>,
      resolvedTitlebarTabsTarget
    )
  }
  return createPortal(
    <LiveTerminalTabBar
      // The SSH surface covers the workspace panes, so no workspace tab may read as active then.
      activeTabId={activePanel ? null : activeTabId}
      worktreeId={renderedActiveWorktreeId}
      onActivate={activateWorkspaceTab}
      onClose={handleCloseTab}
      onCloseOthers={handleCloseOthers}
      onCloseToRight={handleCloseTabsToRight}
      onCloseToLeft={handleCloseTabsToLeft}
      onNewTerminalTab={() => handleNewTab()}
      onNewTerminalWithShell={handleNewTab}
      onNewBrowserTab={handleNewBrowserTab}
      onNewSimulatorTab={mobileEmulatorEnabled ? handleNewSimulatorTab : undefined}
      onOpenEntry={handleOpenEntry}
      onNewFileTab={handleNewFile}
      onSetCustomTitle={setTabCustomTitle}
      onSetTabColor={setTabColor}
      expandedPaneByTabId={expandedPaneByTabId}
      onTogglePaneExpand={handleTogglePaneExpand}
      editorFiles={worktreeFiles}
      browserTabs={worktreeBrowserTabs}
      clientHostedBrowserRows={worktreeClientHostedBrowserRows}
      activeFileId={activeFileId}
      activeBrowserTabId={activeBrowserTabId}
      activeSimulatorTabId={
        activeTabType === 'simulator' && renderedActiveWorktreeId
          ? (useAppStore.getState().getActiveTab(renderedActiveWorktreeId)?.id ?? null)
          : null
      }
      activeTabType={activeTabType}
      onActivateFile={(fileId) => {
        const unifiedTabs =
          useAppStore.getState().unifiedTabsByWorktree[renderedActiveWorktreeId ?? ''] ?? []
        const unifiedTab = unifiedTabs.find((tab) => tab.id === fileId)
        if (unifiedTab?.contentType === 'simulator') {
          setActiveTab(fileId)
          setActiveTabType('simulator', renderedActiveWorktreeId)
          return
        }
        setActiveFile(fileId)
        setActiveTabType('editor', renderedActiveWorktreeId)
      }}
      onCloseFile={handleCloseFile}
      onActivateBrowserTab={handleActivateBrowserTab}
      onCloseBrowserTab={handleCloseBrowserTab}
      onDuplicateBrowserTab={handleDuplicateBrowserTab}
      onCloseAllFiles={handleCloseAllFiles}
      onMakePreviewFilePermanent={makePreviewFilePermanent}
      onPinFile={pinFile}
      tabBarOrder={tabBarOrder}
      trailingItems={plainItems}
    />,
    resolvedTitlebarTabsTarget
  )
}
