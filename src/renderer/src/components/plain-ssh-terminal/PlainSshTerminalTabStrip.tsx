import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PlainSshPanel, PlainSshPanelTab } from '@/ssh/plain-ssh-terminal-panels'
import { PlainSshTerminalView, type PlainSshTerminalPhase } from './PlainSshTerminalView'

export function phaseText(phase: PlainSshTerminalPhase): string | null {
  switch (phase.kind) {
    case 'opening':
    case 'open':
      return null
    case 'failed':
      return phase.message
    case 'ended':
      return phase.signal
        ? translate(
            'auto.components.plainSshTerminal.endedBySignal',
            'ssh was stopped (signal {{signal}}). Close it when you’re done reading.',
            { signal: phase.signal }
          )
        : translate(
            'auto.components.plainSshTerminal.ended',
            'ssh exited with code {{code}}. Close it when you’re done reading.',
            { code: phase.exitCode }
          )
  }
}

/** One terminal tab's body: its own xterm, phase message and lifecycle; hidden tabs stay mounted. */
export function DirectTerminalTabBody({
  panel,
  tab,
  hidden,
  onCloseTab
}: {
  panel: PlainSshPanel
  tab: PlainSshPanelTab
  hidden: boolean
  onCloseTab: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<PlainSshTerminalPhase>({ kind: 'opening' })
  const message = phaseText(phase)
  return (
    <div
      data-plain-ssh-terminal-tab={tab.id}
      className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')}
    >
      {message ? (
        <p className="px-3 py-1.5 text-xs text-destructive [overflow-wrap:anywhere]">{message}</p>
      ) : null}
      {/* An empty terminal under a failed open's error would read as a live session. */}
      <div
        data-plain-ssh-screen
        className={cn('min-h-0 flex-1', phase.kind === 'failed' && 'hidden')}
      >
        <PlainSshTerminalView
          targetId={panel.targetId}
          hidden={hidden}
          onPhase={setPhase}
          sessionKey={`plain-ssh:${panel.targetId}:${tab.id}`}
          attachSessionId={tab.attachSessionId}
          onCleanExit={onCloseTab}
        />
      </div>
    </div>
  )
}
