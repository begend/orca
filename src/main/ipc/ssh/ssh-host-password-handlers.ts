import { ipcMain } from 'electron'
import type { SshHostPasswordStore } from '../../ssh/ssh-host-password-store'
import { isRuntimeOwnedSshTarget } from '../../ssh/connection/ssh-connection-store'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'

let sshHostPasswordStore: SshHostPasswordStore | null = null

export function setSshHostPasswordStore(store: SshHostPasswordStore | null): void {
  sshHostPasswordStore = store
}

export function getSshHostPasswordStore(): SshHostPasswordStore | null {
  return sshHostPasswordStore
}

export function registerSshHostPasswordHandlers(): void {
  ipcMain.handle(
    'ssh:saveTargetPassword',
    (_event, args: { targetId: string; password: unknown }) => {
      const store = requireStore()
      const target = requireEditableTarget(args.targetId)
      // IPC values are untrusted, and the password is never mirrored back to the renderer.
      if (typeof args.password !== 'string') {
        throw new Error('SSH host password must be a string')
      }
      if (args.password.trim() === '') {
        store.clear(target.id)
      } else {
        store.save(target.id, args.password)
      }
      return { configured: store.has(target.id), protection: store.protection(target.id) }
    }
  )

  ipcMain.handle('ssh:clearTargetPassword', (_event, args: { targetId: string }) => {
    const store = requireStore()
    requireEditableTarget(args.targetId)
    store.clear(args.targetId)
  })
}

function requireStore(): SshHostPasswordStore {
  if (!sshHostPasswordStore) {
    throw new Error('SSH host password storage is unavailable')
  }
  return sshHostPasswordStore
}

function requireEditableTarget(targetId: string): { id: string } {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  if (!target) {
    throw new Error(`SSH target "${targetId}" not found`)
  }
  if (isRuntimeOwnedSshTarget(target)) {
    throw new Error('Managed runtime SSH targets cannot store passwords.')
  }
  return target
}
