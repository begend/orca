import { describe, it, expect, vi } from 'vitest'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { safeParseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

createStoreCascadesMockApi()

describe('direct-SSH canonical terminal tabs', () => {
  it('creates a canonical tab carrying the direct transport descriptor and full tab identity', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const tab = store.getState().createTab(wt, undefined, undefined, {
      directSsh: { targetId: 'host-a' }
    })

    expect(tab.directSsh).toEqual({ targetId: 'host-a' })
    // ptyId stays unbound: the direct transport owns its session identity, never the provider.
    expect(tab.ptyId).toBeNull()
    const unified = store
      .getState()
      .unifiedTabsByWorktree[wt]?.find((entry) => entry.entityId === tab.id)
    expect(unified?.contentType).toBe('terminal')
    const group = store.getState().groupsByWorktree[wt]?.[0]
    expect(group?.tabOrder).toContain(unified?.id)
    const layout = store.getState().terminalLayoutsByTabId[tab.id]
    expect(layout?.root?.type).toBe('leaf')
  })

  it('round-trips the descriptor through the persisted session payload', () => {
    const store = createTestStore()
    const wt = FLOATING_TERMINAL_WORKTREE_ID
    seedStore(store, {
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })
    const tab = store.getState().createTab(wt, undefined, undefined, {
      directSsh: { targetId: 'host-b' }
    })

    const payload = buildWorkspaceSessionPayload(store.getState())
    const parsed = safeParseWorkspaceSession(JSON.parse(JSON.stringify(payload)))
    expect(parsed).not.toBeNull()
    const restored = parsed?.success
      ? parsed.data.tabsByWorktree[wt]?.find((entry) => entry.id === tab.id)
      : undefined
    expect(restored?.directSsh).toEqual({ targetId: 'host-b' })
  })

  it('rejects the descriptor on ordinary tabs and keeps local shells provider-backed', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const local = store.getState().createTab(wt)
    expect(local.directSsh).toBeUndefined()
  })
})
