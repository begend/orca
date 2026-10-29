// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: 'wt-a',
    rightSidebarOpen: true,
    sidebarOpen: true,
    groupsByWorktree: {}
  }
  const model = {
    activeTab: { id: 'tab-1', entityId: 'term-1', contentType: 'terminal' },
    agentSessionItems: [],
    browserItems: [],
    commands: { focusGroup: () => undefined, closeGroup: () => undefined },
    editorItems: [],
    tabBarOrder: [],
    terminalTabs: [] as {
      id: string
      title: string
      customTitle: string | null
      directSsh?: { targetId: string }
    }[],
    groupTabs: [],
    expandedPaneByTabId: {}
  }
  const useAppStore = (selector: (current: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { model, useAppStore }
})
vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => null
}))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => mocks.model
}))
vi.mock('../plain-ssh-terminal/DirectSshFilesDialog', () => ({
  DirectSshFilesDialog: ({ targetId }: { targetId: string }) => (
    <button type="button">Files {targetId}</button>
  )
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import TabGroupPanel from './TabGroupPanel'

function panel(isFocused: boolean): React.JSX.Element {
  return (
    <TooltipProvider>
      <TabGroupPanel
        groupId="group-a"
        worktreeId="wt-a"
        isVisible
        isFocused={isFocused}
        hasSplitGroups
        touchesLeftEdge={false}
        touchesRightEdge={false}
        reserveClosedExplorerToggleSpace={false}
        reserveCollapsedSidebarHeaderSpace={false}
      />
    </TooltipProvider>
  )
}

afterEach(() => {
  mocks.model.terminalTabs = []
  cleanup()
})

describe('TabGroupPanel Pane Actions menu', () => {
  it('shows Files for the focused canonical direct SSH tab', () => {
    mocks.model.terminalTabs = [
      {
        id: 'term-1',
        title: 'Build box',
        customTitle: null,
        directSsh: { targetId: 'build-box' }
      }
    ]

    const view = render(panel(true))

    expect(view.getByRole('button', { name: 'Files build-box' })).not.toBeNull()
    view.rerender(panel(false))
    expect(view.queryByRole('button', { name: 'Files build-box' })).toBeNull()
  })

  it('closes without restoring focus to the old group', async () => {
    const view = render(panel(true))
    const trigger = view.getByRole('button', { name: 'Pane Actions' })
    act(() => {
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
        pointerType: 'mouse'
      })
    })
    expect(view.queryByRole('menuitem', { name: 'Close split pane' })).not.toBeNull()

    await act(async () => {
      view.rerender(panel(false))
      // Radix restores trigger focus on the next task after its focus scope unmounts.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.queryByRole('menuitem', { name: 'Close split pane' })).toBeNull()
    expect(document.activeElement).not.toBe(trigger)

    view.rerender(panel(true))
    expect(view.queryByRole('menuitem', { name: 'Close split pane' })).toBeNull()
  })
})
