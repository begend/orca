// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientHostedBrowserRow } from '../../../shared/client-hosted-browser-rows'
import {
  applyClientHostedBrowserRows,
  getClientHostedBrowserRows
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import { TerminalTitlebarTabs } from './TerminalTitlebarTabs'
import type { TerminalController } from './use-terminal-controller'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  tabBarProps: [] as Record<string, unknown>[]
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('./tab-bar/TabBar', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.tabBarProps.push(props)
    return null
  }
}))
vi.mock('./plain-ssh-terminal/DirectSshTabActions', () => ({
  directSshFilesTarget: (tab: { directSsh?: { targetId: string } } | undefined) =>
    tab?.directSsh ? { targetId: tab.directSsh.targetId } : undefined,
  DirectSshTabActions: ({ target }: { target?: { targetId: string } }) =>
    target ? <button type="button">Files {target.targetId}</button> : null
}))

const WORKTREE_ID = 'repo-1::/repo/worktree'
const ROW: ClientHostedBrowserRow = {
  browserPageId: 'page-1',
  title: 'Client page',
  url: 'https://example.com'
} as ClientHostedBrowserRow

let titlebarTarget: HTMLElement
let container: HTMLElement
let root: ReturnType<typeof createRoot>

function renderTitlebarTabs(
  options: { activeTabId?: string | null; split?: boolean } = {}
): HTMLElement {
  const controller = {
    activeBrowserTabId: null,
    activeFileId: null,
    activeTabId: options.activeTabId ?? null,
    activeTabType: 'terminal',
    effectiveActiveLayout: options.split ? { type: 'leaf', groupId: 'group-1' } : null,
    expandedPaneByTabId: {},
    handleActivateBrowserTab: vi.fn(),
    handleActivateTab: vi.fn(),
    handleCloseAllFiles: vi.fn(),
    handleCloseBrowserTab: vi.fn(),
    handleCloseFile: vi.fn(),
    handleCloseOthers: vi.fn(),
    handleCloseTab: vi.fn(),
    handleCloseTabsToLeft: vi.fn(),
    handleCloseTabsToRight: vi.fn(),
    handleDuplicateBrowserTab: vi.fn(),
    handleNewBrowserTab: vi.fn(),
    handleNewFile: vi.fn(),
    handleNewSimulatorTab: vi.fn(),
    handleNewTab: vi.fn(),
    handleOpenEntry: vi.fn(),
    handleTogglePaneExpand: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    mobileEmulatorEnabled: false,
    pinFile: vi.fn(),
    renderedActiveWorktreeId: WORKTREE_ID,
    setActiveFile: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabColor: vi.fn(),
    setTabCustomTitle: vi.fn(),
    tabBarOrder: [],
    titlebarTabsTarget: titlebarTarget,
    worktreeBrowserTabs: [],
    // Mirrors the projection hook's derivation so the assertion follows the real row store.
    worktreeClientHostedBrowserRows: getClientHostedBrowserRows(WORKTREE_ID),
    worktreeFiles: []
  } as unknown as TerminalController
  root = createRoot(container)
  act(() => root.render(<TerminalTitlebarTabs controller={controller} />))
  return titlebarTarget
}

describe('TerminalTitlebarTabs', () => {
  beforeEach(() => {
    mocks.tabBarProps = []
    mocks.state = { tabsByWorktree: {}, unifiedTabsByWorktree: {}, getActiveTab: () => null }
    titlebarTarget = document.createElement('div')
    container = document.createElement('div')
    document.body.append(titlebarTarget, container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    applyClientHostedBrowserRows({ worktreeId: WORKTREE_ID, rows: [] })
    titlebarTarget.remove()
    container.remove()
  })

  it('forwards client-hosted browser rows to the titlebar tab bar', () => {
    applyClientHostedBrowserRows({ worktreeId: WORKTREE_ID, rows: [ROW] })
    renderTitlebarTabs()
    expect(mocks.tabBarProps.at(-1)?.clientHostedBrowserRows).toEqual([ROW])
  })

  it('passes no rows when the worktree has none', () => {
    renderTitlebarTabs()
    expect(mocks.tabBarProps.at(-1)?.clientHostedBrowserRows).toEqual([])
  })

  it('shows Files beside the non-split titlebar tabs for an active direct terminal', () => {
    mocks.state = {
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'direct-tab',
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: 'Build box',
            color: null,
            sortOrder: 0,
            createdAt: 1,
            directSsh: { targetId: 'build-box' }
          }
        ]
      },
      unifiedTabsByWorktree: {},
      getActiveTab: () => null
    }

    const target = renderTitlebarTabs({ activeTabId: 'direct-tab' })

    expect(target.textContent).toContain('Files build-box')
  })

  it('keeps Files available from a persisted direct unified projection before its terminal row restores', () => {
    mocks.state = {
      tabsByWorktree: { [WORKTREE_ID]: [] },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'direct-tab',
            entityId: 'direct-tab',
            groupId: 'group-1',
            worktreeId: WORKTREE_ID,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: 'Renamed shell',
            color: null,
            sortOrder: 0,
            createdAt: 1,
            directSsh: { targetId: 'build-box' }
          }
        ]
      },
      getActiveTab: () => null
    }

    const target = renderTitlebarTabs({ activeTabId: 'direct-tab' })

    expect(target.textContent).toContain('Files build-box')
  })

  it('does not render titlebar Files chrome for split workspaces', () => {
    mocks.state = { tabsByWorktree: {}, unifiedTabsByWorktree: {}, getActiveTab: () => null }

    const target = renderTitlebarTabs({ split: true })

    expect(target.textContent).not.toContain('Files')
    expect(mocks.tabBarProps).toEqual([])
  })
})
