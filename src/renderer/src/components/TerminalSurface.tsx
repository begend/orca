import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { usePlainSshPanels } from '@/ssh/plain-ssh-terminal-panels'
import { PlainSshTerminalPanels } from './plain-ssh-terminal/PlainSshTerminalPanels'
import EditorAutosaveController from './editor/EditorAutosaveController'
import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { TerminalTitlebarTabs } from './TerminalTitlebarTabs'
import { TerminalSplitWorkspaceSurfaces } from './TerminalSplitWorkspaceSurfaces'
import { TerminalLegacyWorkspaceSurface } from './TerminalLegacyWorkspaceSurface'
import { TerminalWorkspaceDialogs } from './TerminalWorkspaceDialogs'
import type { TerminalController } from './use-terminal-controller'

export function TerminalSurface({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const { renderedActiveWorktreeId } = controller
  const directPanels = usePlainSshPanels().filter((panel) => panel.direct)
  const sshPanelActive = directPanels.some((panel) => !panel.minimized)
  // Read the portal host after commit: during this component's first render the workbench
  // ancestor (and its host div) is not in the document yet.
  const [sshTarget, setSshTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setSshTarget(
      directPanels.length > 0 ? document.getElementById('plain-ssh-terminal-surface') : null
    )
  }, [directPanels.length])
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(
    !renderedActiveWorktreeId && !sshPanelActive
  )
  return (
    <div
      // The workbench already removes hidden content from flow; only keep this ancestor paintable.
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        renderedActiveWorktreeId || sshPanelActive
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
      data-rendered-active-worktree-id={renderedActiveWorktreeId ?? undefined}
    >
      <EditorAutosaveController />
      <TerminalTitlebarTabs controller={controller} />
      <TerminalSplitWorkspaceSurfaces controller={controller} />
      <TerminalLegacyWorkspaceSurface controller={controller} />
      <TerminalWorkspaceDialogs controller={controller} />
      {sshTarget
        ? directPanels.map((panel) =>
            createPortal(
              <PlainSshTerminalPanels surfaceOnly targetId={panel.targetId} />,
              sshTarget,
              panel.targetId
            )
          )
        : null}
    </div>
  )
}
