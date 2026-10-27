import { appendFileSync } from 'node:fs'
import type { DirectSshAuthority, SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import { createCancelledConnectAttemptError } from '../../ssh/ssh-connect-attempt-cancellation'
import { errorMessage } from '../../../shared/error-message'
import { setDirectSshMode } from '../../ssh/direct-ssh/direct-ssh-mode'
import {
  findDirectSshSecurityKeyBlocker,
  isDirectSshTarget
} from '../../ssh/direct-ssh/direct-ssh-target'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../../ssh/ssh-provider-authority'
import {
  adoptSshConnection,
  runAttributedToSshOwner
} from '../../ssh/connection/ssh-connection-attribution'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { noteRuntimeEnvironmentConnectRequested } from '../runtime-environments/runtime-environment-pairing-refusal-registry'
import {
  decideHostServer,
  recheckWhenManagedFenceClears,
  publishHostServerDecisionFailure,
  publishBridgedUnservedHostServer,
  publishManagedServerConnect,
  publishUnservedHostServer
} from './ssh-host-server-connect'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  isCurrentConnectAttempt
} from './ssh-connect-attempt-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { abandonDecisionTransport } from './ssh-session-teardown'
import { broadcastSshState, getPublicSshState } from './ssh-renderer-broadcast'
import { awaitTargetLifecycle } from './ssh-target-lifecycle-queue'
import { startLegacyRelayBridge } from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { clearSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import {
  createSshUserDisconnectedError,
  isSshUserDisconnected
} from '../../ssh/ssh-user-disconnect'
import {
  liftSshHostUserDisconnect,
  resumeRuntimeEnvironmentStatus
} from './ssh-host-user-disconnect'

/** `automatic`: no user asked for this connect, so a cancelled sign-in or a Disconnect stays. */
export async function connectTarget(
  targetId: string,
  options: { automatic?: boolean } = {}
): Promise<SshConnectionState> {
  const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
  if (e2eProbePath) {
    appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
    throw new Error('e2e_forbidden_local_ssh_connect')
  }
  if (options.automatic) {
    // Preserve disconnected status rather than publishing an unwanted failed connect.
    if (isSshUserDisconnected(targetId)) {
      const label = getSshTargetRegistryStore()?.getTarget(targetId)?.label ?? targetId
      throw createSshUserDisconnectedError(label)
    }
    return admitConnect(targetId)
  }
  clearSshCredentialDeclined(targetId)
  // Only explicit user connects may lift the re-pair cap.
  const managedEnvironmentId = getManagedOrcadFenceEnvironmentId(
    getSshTargetRegistryStore()?.getTarget(targetId)
  )
  if (managedEnvironmentId) {
    noteRuntimeEnvironmentConnectRequested(managedEnvironmentId)
  }
  const liftedEnvironments = liftSshHostUserDisconnect(targetId)
  try {
    return await admitConnect(targetId)
  } finally {
    resumeRuntimeEnvironmentStatus(liftedEnvironments)
  }
}

async function admitConnect(targetId: string): Promise<SshConnectionState> {
  // Fence requests that entered before disconnect/reset but resume after its cleanup.
  const admissionAuthority = getSshProviderAuthority(targetId)
  await awaitTargetLifecycle(targetId)

  // Coalesce concurrent connects to avoid leaking the first session.
  const existing = connectInFlight.get(targetId)
  let replacePendingTransport = false
  if (existing) {
    if (isCurrentConnectAttempt(targetId, existing.authority)) {
      return existing.promise
    }
  }
  if (!isCurrentConnectAttempt(targetId, admissionAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  const observedAuthority = admissionAuthority
  if (existing) {
    if (connectInFlight.get(targetId) === existing) {
      connectInFlight.delete(targetId)
      replacePendingTransport = true
    }
  }
  if (!isCurrentSshProviderAuthority(observedAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  // Shutdown fences and snapshots synchronously; register below or fail here without an admission gap.
  assertSshConnectsNotFenced()

  const promise = doConnect(targetId, replacePendingTransport)
  const attempt = { authority: getSshProviderAuthority(targetId), promise }
  connectInFlight.set(targetId, attempt)
  try {
    return await promise
  } finally {
    if (connectInFlight.get(targetId) === attempt) {
      connectInFlight.delete(targetId)
    }
  }
}

async function doConnect(
  targetId: string,
  replacePendingTransport = false
): Promise<SshConnectionState> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target) {
    throw new Error(`SSH target "${targetId}" not found`)
  }

  const authority = rotateSshProviderAuthority(targetId)
  if (replacePendingTransport) {
    await connectionManager!.disconnect(targetId)
    if (!isCurrentConnectAttempt(targetId, authority)) {
      throw createCancelledConnectAttemptError()
    }
  }

  // Attribute decision-created transports so cancellation closes only those not adopted by a newer owner.
  const owner = Symbol(targetId)
  if (isDirectSshTarget(target)) {
    return connectDirectSshTarget(target, authority, owner)
  }
  // Deploy/conversion require teardown first; rotated authority still lets concurrent connects join.
  const server = await runAttributedToSshOwner(owner, () => decideHostServer(target)).catch(
    async (error: unknown) => {
      if (!isCurrentConnectAttempt(targetId, authority)) {
        await abandonDecisionTransport(targetId, owner, authority)
        throw createCancelledConnectAttemptError()
      }
      // A failed setup leaves no relay to own the transport its decision dialed.
      await abandonDecisionTransport(targetId, owner, authority)
      publishHostServerDecisionFailure(targetId, error)
      throw error
    }
  )
  // A shutdown that began during the decision is the actionable reason, ahead of the rotation.
  assertSshConnectsNotFenced()
  if (!isCurrentConnectAttempt(targetId, authority)) {
    await abandonDecisionTransport(targetId, owner, authority)
    throw createCancelledConnectAttemptError()
  }
  adoptCurrentTransport(targetId, owner)
  if (server.route === 'managed') {
    if (server.fenceHeld) {
      recheckWhenManagedFenceClears(target, server.environmentId)
    }
    // COMPAT(legacy-relay-bridge): panes an older relay still runs are known before the host is.
    await startLegacyRelayBridge(targetId)
    // A disconnect or shutdown during the bridge wait already published; "connected" would be stale.
    assertSshConnectsNotFenced()
    if (!isCurrentConnectAttempt(targetId, authority)) {
      await abandonDecisionTransport(targetId, owner, authority)
      throw createCancelledConnectAttemptError()
    }
    const published = publishManagedServerConnect(
      targetId,
      server.environmentId,
      server.update,
      server.serving,
      server.linked
    )
    // Publish first; the macOS-only check adds remote round trips.
    void import('./ssh-host-launch-session-note')
      .then(({ noteEndedLaunchSshSession }) =>
        noteEndedLaunchSshSession(targetId, server.environmentId)
      )
      .catch(() => {})
    return published
  }
  if (server.bridged) {
    // COMPAT(legacy-relay-bridge): the move waits for relay terminals the bridge keeps serving.
    await startLegacyRelayBridge(targetId)
    assertSshConnectsNotFenced()
    if (!isCurrentConnectAttempt(targetId, authority)) {
      await abandonDecisionTransport(targetId, owner, authority)
      throw createCancelledConnectAttemptError()
    }
    return publishBridgedUnservedHostServer(target, server)
  }
  // Unserved hosts have no relay fallback.
  await abandonDecisionTransport(targetId, owner, authority)
  throw publishUnservedHostServer(target, server)
}

function adoptCurrentTransport(targetId: string, owner: symbol): void {
  const current = connectionManager!.getConnection(targetId)
  if (current) {
    adoptSshConnection(current, owner)
  }
}

/** FinalShell-style connect for manual hosts: standard SSH only — no host-server decision,
 * deploy, migration or managed tunnel. Terminal and SFTP come from the Direct SSH module. */
async function connectDirectSshTarget(
  target: SshTarget,
  authority: DirectSshAuthority,
  owner: symbol
): Promise<SshConnectionState> {
  if (await findDirectSshSecurityKeyBlocker(target)) {
    throw await failDirectSshConnect(
      target.id,
      authority,
      'This host authenticates with a hardware security key, which needs the system OpenSSH ' +
        'client. One-click sign-in supports passwords and standard key files only.'
    )
  }
  try {
    await runAttributedToSshOwner(owner, () => connectionManager!.connect(target))
  } catch (error) {
    if (!isCurrentConnectAttempt(target.id, authority)) {
      throw createCancelledConnectAttemptError()
    }
    publishHostServerDecisionFailure(target.id, error)
    throw error
  }
  assertSshConnectsNotFenced()
  if (!isCurrentConnectAttempt(target.id, authority)) {
    throw createCancelledConnectAttemptError()
  }
  const connection = connectionManager!.getConnection(target.id)
  if (!connection || connection.usesSystemSshTransport()) {
    throw await failDirectSshConnect(
      target.id,
      authority,
      'This host needs the system OpenSSH transport (proxy, jump host or security key), which ' +
        "doesn't support the direct terminal and file browser. Orca left it disconnected."
    )
  }
  adoptCurrentTransport(target.id, owner)
  setDirectSshMode(target.id)
  const state: SshConnectionState = {
    ...(connectionManager!.getState(target.id) ?? { targetId: target.id, reconnectAttempt: 0 }),
    targetId: target.id,
    status: 'connected',
    error: null
  }
  broadcastSshState(getCurrentMainWindow, target.id, state)
  return getPublicSshState(target.id) ?? state
}

/** An unusable direct host must not keep a connected transport it can't serve. */
async function failDirectSshConnect(
  targetId: string,
  authority: DirectSshAuthority,
  message: string
): Promise<Error> {
  const opened = connectionManager!.getConnection(targetId)
  if (opened) {
    try {
      await connectionManager!.disconnectConnection(targetId, opened)
    } catch (error) {
      console.warn(
        `[ssh] Failed to close the transport of unsupported direct host ${targetId}: ${errorMessage(error)}`
      )
    }
  }
  if (!isCurrentConnectAttempt(targetId, authority)) {
    return createCancelledConnectAttemptError()
  }
  const failure = new Error(message)
  publishHostServerDecisionFailure(targetId, failure)
  return failure
}
