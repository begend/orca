/** The per-target record that stamps every connected broadcast with Direct SSH mode, and the
 * refusals relay-only features use when they reach a Direct host. Mirrors the historical
 * plain-ssh-mode contract so `plainSsh` stays additive for older clients. */
import type { SshPlainSshMode } from '../../../shared/ssh-types'

const DIRECT_MODE: SshPlainSshMode = {
  reason: 'manual-direct',
  message:
    'Connected directly with standard SSH: a terminal and SFTP file browsing, no Orca server on the host.'
}

const modes = new Map<string, SshPlainSshMode>()

export function setDirectSshMode(targetId: string): void {
  modes.set(targetId, DIRECT_MODE)
}

export function clearDirectSshMode(targetId: string): void {
  modes.delete(targetId)
}

export function getDirectSshMode(targetId: string): SshPlainSshMode | undefined {
  return modes.get(targetId)
}

/** Refusal for an operation only the Orca remote server can perform on this host. */
export class DirectSshUnsupportedError extends Error {
  readonly code = 'direct_ssh_unsupported'

  constructor(feature: string) {
    super(
      `${feature} needs the Orca remote server, which direct SSH hosts don't run. Save the host through SSH config import to use it.`
    )
    this.name = 'DirectSshUnsupportedError'
  }
}
