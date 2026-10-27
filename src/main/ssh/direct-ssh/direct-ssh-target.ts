/** The one gate deciding whether a saved host connects as FinalShell-style Direct SSH: a
 * desktop-owned manually-added host whose transport ssh2 can carry, so shell and SFTP need no
 * remote Orca server. Config-imported, runtime-owned, managed-fenced and system-OpenSSH-only
 * targets keep their existing paths. */
import type { SshTarget } from '../../../shared/ssh-types'
import { isSshConfigSourcedTarget } from '../../../shared/ssh-target-source'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { requiresSystemSshForSecurityKey } from '../ssh-transport-selection'

export type DirectSshTargetBlocker =
  | { kind: 'config-sourced' }
  | { kind: 'runtime-owned' }
  | { kind: 'managed-fence' }
  | { kind: 'system-ssh-only'; detail: string }

/** Sync-only view used on hot paths (routing, teardown, broadcast); never dials or reads files. */
export function findDirectSshTargetBlocker(target: SshTarget): DirectSshTargetBlocker | null {
  if (target.owner) {
    return { kind: 'runtime-owned' }
  }
  if (isSshConfigSourcedTarget(target)) {
    return { kind: 'config-sourced' }
  }
  if (getManagedOrcadFenceEnvironmentId(target)) {
    return { kind: 'managed-fence' }
  }
  const systemOnly = syncSystemSshOnlyDetail(target)
  if (systemOnly) {
    return { kind: 'system-ssh-only', detail: systemOnly }
  }
  return null
}

export function isDirectSshTarget(target: SshTarget): boolean {
  return findDirectSshTargetBlocker(target) === null
}

/** Connect-time refinement: a FIDO/sk security key forces the system OpenSSH transport. */
export async function findDirectSshSecurityKeyBlocker(target: SshTarget): Promise<boolean> {
  return requiresSystemSshForSecurityKey(target, null)
}

function syncSystemSshOnlyDetail(target: SshTarget): string | null {
  if (target.proxyCommand) {
    return 'ProxyCommand'
  }
  if (target.jumpHost) {
    return 'ProxyJump'
  }
  if (target.gssapiAuthentication) {
    return 'GSSAPI'
  }
  if (target.identityAgent) {
    return 'IdentityAgent'
  }
  return null
}
