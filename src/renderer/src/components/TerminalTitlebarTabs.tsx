import { createPortal } from 'react-dom'
import { useLayoutEffect, useState } from 'react'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '../store'
import TabBar from './tab-bar/TabBar'
import { directSshFilesTarget, DirectSshTabActions } from './plain-ssh-terminal/DirectSshTabActions'
import type { TerminalController } from './use-terminal-controller'

const EMPTY_TERMINAL_TABS: TerminalTab[] = []

// Isolate title subscriptions so renames do not rerender the topology-owning Terminal root.
function LiveTerminalTitlebarChrome(
  props: Omit<React.ComponentProps<typeof TabBar>, 'tabs'> & {
    activeTabType: TerminalController['activeTabType']
  }
): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabsByWorktree[props.worktreeId] ?? EMPTY_TERMINAL_TABS)
  const activeDirectSsh =
    props.activeTabType === 'terminal'
      ? directSshFilesTarget(tabs.find((tab) => tab.id === props.activeTabId))
      : undefined
  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="min-w-0 flex-1">
        <TabBar {...props} tabs={tabs} />
      </div>
      <div
        className="flex shrink-0 items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <DirectSshTabActions target={activeDirectSsh} />
      </div>
    </div>
  )
}

export function TerminalTitlebarTabs({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  // The projection hook reads the host during render, before the app shell's conditional
  // titlebar mounts; track it so the first committed portal has a target instead of null.
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
  const resolvedTitlebarTabsTarget = portalTarget ?? titlebarTabsTarget
  // Split layouts draw per-group strips; the unified titlebar bar would duplicate them.
  if (!resolvedTitlebarTabsTarget || effectiveActiveLayout) {
    return null
  }
  if (!renderedActiveWorktreeId) {
    return null
  }
  return createPortal(
    <LiveTerminalTitlebarChrome
      activeTabId={activeTabId}
      worktreeId={renderedActiveWorktreeId}
      onActivate={handleActivateTab}
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
    />,
    resolvedTitlebarTabsTarget
  )
}
