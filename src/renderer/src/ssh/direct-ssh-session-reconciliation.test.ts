// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileDirectSshLayoutBindings,
  reconcileDirectSshSessionsInStore
} from './direct-ssh-session-reconciliation'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

const list = vi.fn()

beforeEach(() => {
  list.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plainSsh: { list } }
  })
})

const layout: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'left' },
    second: { type: 'leaf', leafId: 'right' }
  },
  activeLeafId: 'left',
  expandedLeafId: null,
  lastGridsByLeafId: {
    left: { cols: 80, rows: 24 },
    right: { cols: 120, rows: 40 }
  }
}

function tab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'floating',
    title: 'Build box',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    directSsh: { targetId: 'build-box' }
  }
}

describe('direct SSH session reconciliation', () => {
  it('matches detached sessions to their exact tab and leaf identity', () => {
    const reconciled = reconcileDirectSshLayoutBindings(
      layout,
      [
        { sessionId: 'right-session', tabId: 'tab-1', leafId: 'right', cols: 80, rows: 24 },
        { sessionId: 'left-session', tabId: 'tab-1', leafId: 'left', cols: 120, rows: 40 }
      ],
      'tab-1'
    )

    expect(reconciled.ptyIdsByLeafId).toEqual({
      left: 'direct-ssh:left-session',
      right: 'direct-ssh:right-session'
    })
  })

  it('does not adopt a legacy session that lacks exact pane identity', () => {
    const reconciled = reconcileDirectSshLayoutBindings(
      layout,
      [{ sessionId: 'legacy-session', cols: 80, rows: 24 }],
      'tab-1'
    )

    expect(reconciled).toBe(layout)
  })

  it('lists once per target and restores live bindings before panes mount', async () => {
    list.mockResolvedValue({
      sessions: [
        { sessionId: 'right-session', tabId: 'tab-1', leafId: 'right', cols: 80, rows: 24 },
        { sessionId: 'left-session', tabId: 'tab-1', leafId: 'left', cols: 120, rows: 40 }
      ]
    })
    const setTabLayout = vi.fn()

    await reconcileDirectSshSessionsInStore({
      tabsByWorktree: { floating: [tab()] },
      terminalLayoutsByTabId: { 'tab-1': layout },
      setTabLayout
    })

    expect(list).toHaveBeenCalledWith({ targetId: 'build-box' })
    expect(setTabLayout).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        ptyIdsByLeafId: {
          left: 'direct-ssh:left-session',
          right: 'direct-ssh:right-session'
        }
      })
    )
  })
})
