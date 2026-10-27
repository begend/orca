import { useState } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  PLAIN_SSH_FILES_TAB_ID,
  addPlainSshPanelTab,
  closePlainSshPanelTab,
  setActivePlainSshPanelTab,
  type PlainSshPanel,
  type PlainSshPanelTab
} from '@/ssh/plain-ssh-terminal-panels'
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

export function TerminalTabStrip({
  panel,
  filesAvailable,
  terminalTabLabel
}: {
  panel: PlainSshPanel
  filesAvailable: boolean
  terminalTabLabel: string
}): React.JSX.Element {
  const filesActive = panel.selectedTabId === PLAIN_SSH_FILES_TAB_ID
  return (
    <div
      role="tablist"
      aria-label={translate('auto.components.plainSshTerminal.views', 'Host views')}
      className="flex min-w-0 items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {panel.tabs.map((tab, index) => {
        const active = panel.selectedTabId === tab.id
        const label = `${terminalTabLabel} ${index + 1}`
        return (
          <div
            key={tab.id}
            className={cn(
              'flex items-center rounded-sm',
              active ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent'
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="flex min-w-0 items-center px-1.5 py-0.5 text-xs"
              onClick={() => setActivePlainSshPanelTab(panel.targetId, tab.id)}
            >
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-label={translate('auto.components.plainSshTerminal.closeTab', 'Close tab')}
              className="mr-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => closePlainSshPanelTab(panel.targetId, tab.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={translate('auto.components.plainSshTerminal.newTab', 'New terminal')}
            onClick={() => {
              addPlainSshPanelTab(panel.targetId)
            }}
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {translate('auto.components.plainSshTerminal.newTab', 'New terminal')}
        </TooltipContent>
      </Tooltip>
      {filesAvailable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant={filesActive ? 'secondary' : 'ghost'}
              role="tab"
              aria-selected={filesActive}
              aria-label={translate('auto.components.plainSshTerminal.filesTab', 'Files')}
              onClick={() => setActivePlainSshPanelTab(panel.targetId, PLAIN_SSH_FILES_TAB_ID)}
            >
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('auto.components.plainSshTerminal.filesTab', 'Files')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
