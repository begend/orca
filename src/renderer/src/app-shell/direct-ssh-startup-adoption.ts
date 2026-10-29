import { reconcileDirectSshSessionsInStore } from '../ssh/direct-ssh-session-reconciliation'
import { useAppStore } from '../store'
import { timeRendererStartupStep } from '../startup/startup-diagnostics'

/** Adopt surviving main-owned direct sessions before terminal panes begin connecting. */
export function adoptDirectSshSessionsAtStartup(): Promise<void> {
  return timeRendererStartupStep('adopt-direct-ssh-sessions', async () => {
    if (window.api.plainSsh) {
      await reconcileDirectSshSessionsInStore(useAppStore.getState())
    }
  })
}
