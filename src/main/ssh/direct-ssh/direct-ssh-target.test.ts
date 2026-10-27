import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { findDirectSshTargetBlocker, isDirectSshTarget } from './direct-ssh-target'

function manualTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 't1',
    label: 'cloud',
    host: '203.0.113.7',
    port: 22,
    username: 'ubuntu',
    ...overrides
  }
}

describe('findDirectSshTargetBlocker', () => {
  it('accepts a plain manually-added host', () => {
    expect(findDirectSshTargetBlocker(manualTarget())).toBeNull()
    expect(isDirectSshTarget(manualTarget())).toBe(true)
  })

  it('rejects runtime-owned targets', () => {
    const blocker = findDirectSshTargetBlocker(
      manualTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' } })
    )
    expect(blocker?.kind).toBe('runtime-owned')
  })

  it('rejects config-sourced targets by source', () => {
    expect(findDirectSshTargetBlocker(manualTarget({ source: 'ssh-config' }))?.kind).toBe(
      'config-sourced'
    )
  })

  it('rejects legacy config-import shapes whose source was never written', () => {
    const legacy = manualTarget({
      label: 'alias',
      configHost: 'alias',
      host: 'resolved.example.com'
    })
    expect(findDirectSshTargetBlocker(legacy)?.kind).toBe('config-sourced')
  })

  it('rejects managed-fenced targets', () => {
    const blocker = findDirectSshTargetBlocker(
      manualTarget({ orcadFence: { environmentId: 'env-9' } })
    )
    expect(blocker?.kind).toBe('managed-fence')
  })

  it.each<[string, Partial<SshTarget>]>([
    ['proxyCommand', { proxyCommand: 'ssh -W %h:%p jumphost' }],
    ['jumpHost', { jumpHost: 'jumphost' }],
    ['gssapiAuthentication', { gssapiAuthentication: true }],
    ['identityAgent', { identityAgent: 'auto' }]
  ])('rejects system-OpenSSH-only field %s', (_field, override) => {
    const blocker = findDirectSshTargetBlocker(manualTarget(override))
    expect(blocker?.kind).toBe('system-ssh-only')
    if (blocker?.kind === 'system-ssh-only') {
      expect(blocker.detail.length).toBeGreaterThan(0)
    }
  })
})
