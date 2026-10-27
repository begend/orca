import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Minimize2, SquareTerminal, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FloatingTerminalResizeHandles } from '@/components/floating-terminal/FloatingTerminalResizeHandles'
import {
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  type FloatingTerminalPanelBounds
} from '@/components/floating-terminal/floating-terminal-panel-bounds'
import {
  PLAIN_SSH_FILES_TAB_ID,
  addPlainSshPanelTab,
  closePlainSshPanelTab,
  getPlainSshPanel,
  minimizePlainSshPanel,
  removePlainSshPanel,
  setActivePlainSshPanelTab,
  showPlainSshPanel,
  usePlainSshPanels,
  type PlainSshPanel
} from '@/ssh/plain-ssh-terminal-panels'
import { PlainSshTerminalView, type PlainSshTerminalPhase } from './PlainSshTerminalView'
import { DirectSshFileBrowser } from './DirectSshFileBrowser'
import { DirectTerminalTabBody, phaseText } from './PlainSshTerminalTabStrip'

export function plainSshUnmanagedNotice(): string {
  return translate(
    'auto.components.plainSshTerminal.unmanaged',
    'Plain SSH — unmanaged. Not an Orca workspace: agents and tabs here aren’t tracked, and this terminal isn’t restored. Closing it ends the SSH session.'
  )
}

export function plainSshDirectUnmanagedNotice(): string {
  return translate(
    'auto.components.plainSshTerminal.unmanagedDirect',
    'Plain SSH — unmanaged. Not an Orca workspace: agents and tabs here aren’t tracked, and this terminal isn’t restored. Closing a tab ends that shell; closing the window ends them all.'
  )
}

function HeaderIconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

type CardDrag = {
  pointerId: number
  startX: number
  startY: number
  bounds: FloatingTerminalPanelBounds
}

/** Adopt the host's detached sessions (or start one shell); mount-only, the store owns tabs after. */
function useDirectSessionAdoption(panel: PlainSshPanel): void {
  useEffect(() => {
    if (!panel.direct) {
      return
    }
    let cancelled = false
    void window.api.plainSsh
      ?.list({ targetId: panel.targetId })
      .then(({ sessionIds }) => {
        if (cancelled) {
          return
        }
        // Read the live store: tabs added by a raced "+" click or StrictMode remount must not duplicate shells.
        const current = getPlainSshPanel(panel.targetId)
        const known = new Set((current?.tabs ?? []).map((tab) => tab.attachSessionId))
        const fresh = sessionIds.filter((sessionId) => !known.has(sessionId))
        if (fresh.length > 0) {
          for (const sessionId of fresh) {
            addPlainSshPanelTab(panel.targetId, { attachSessionId: sessionId })
          }
          if (!current || current.selectedTabId === null) {
            setActivePlainSshPanelTab(panel.targetId, fresh[0])
          }
        } else if ((current?.tabs.length ?? 0) === 0) {
          addPlainSshPanelTab(panel.targetId)
        }
      })
      .catch(() => {
        const current = getPlainSshPanel(panel.targetId)
        if (!cancelled && (current?.tabs.length ?? 0) === 0) {
          addPlainSshPanelTab(panel.targetId)
        }
      })
    return () => {
      cancelled = true
    }
    // Mount-only: the panel store owns tabs from here on.
  }, [panel.direct, panel.targetId])
}

/**
 * Direct-host surface inside the workspace workbench; the titlebar tab strip owns its tabs.
 * Minimized panels stay mounted: unmounting would tear down their xterms and SSH shells.
 */
function DirectSshSurfacePanel({ panel }: { panel: PlainSshPanel }): React.JSX.Element {
  const filesAvailable = Boolean(window.api.directSshFiles)
  useDirectSessionAdoption(panel)
  return (
    <section
      aria-label={translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
        host: panel.label
      })}
      data-plain-ssh-terminal={panel.targetId}
      className={cn(
        'pointer-events-auto absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-background text-foreground',
        panel.minimized && 'hidden'
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-semibold">
          {translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
            host: panel.label
          })}
        </span>
      </div>
      <p className="border-b border-border bg-muted px-3 py-1 text-2xs text-status-warning">
        {plainSshDirectUnmanagedNotice()}
      </p>
      {panel.tabs.map((tab) => (
        <DirectTerminalTabBody
          key={tab.id}
          panel={panel}
          tab={tab}
          hidden={panel.minimized || panel.selectedTabId !== tab.id}
          onCloseTab={() => closePlainSshPanelTab(panel.targetId, tab.id)}
        />
      ))}
      {filesAvailable && panel.selectedTabId === PLAIN_SSH_FILES_TAB_ID ? (
        <DirectSshFileBrowser targetId={panel.targetId} />
      ) : null}
    </section>
  )
}

/** A non-modal host window over Orca; minimized windows wait in a strip at the bottom right. */
function PlainSshTerminalCard({ panel }: { panel: PlainSshPanel }): React.JSX.Element {
  const [phase, setPhase] = useState<PlainSshTerminalPhase>({ kind: 'opening' })
  const [bounds, setBounds] = useState<FloatingTerminalPanelBounds>(() =>
    getDefaultFloatingTerminalBounds()
  )
  const [maximized, setMaximized] = useState(false)
  const restoreBoundsRef = useRef<FloatingTerminalPanelBounds | null>(null)
  const dragRef = useRef<CardDrag | null>(null)
  const message = phaseText(phase)
  const failed = phase.kind === 'failed'

  const toggleMaximized = (): void => {
    if (maximized) {
      const restored = restoreBoundsRef.current ?? getDefaultFloatingTerminalBounds()
      restoreBoundsRef.current = null
      setBounds(clampFloatingTerminalBounds(restored))
      setMaximized(false)
      return
    }
    restoreBoundsRef.current = bounds
    setBounds(getMaximizedFloatingTerminalBounds())
    setMaximized(true)
  }

  const handleDragStart = (event: React.PointerEvent<HTMLElement>): void => {
    const target = event.target
    if (
      event.button !== 0 ||
      maximized ||
      !(target instanceof HTMLElement) ||
      target.closest('button')
    ) {
      return
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      bounds
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleDragMove = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    setBounds(
      clampFloatingTerminalBounds({
        ...drag.bounds,
        left: drag.bounds.left + event.clientX - drag.startX,
        top: drag.bounds.top + event.clientY - drag.startY
      })
    )
  }
  const handleDragEnd = (): void => {
    dragRef.current = null
  }

  return (
    <section
      aria-label={translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
        host: panel.label
      })}
      data-plain-ssh-terminal={panel.targetId}
      // Keep minimized panels mounted to preserve their SSH sessions and scrollback.
      className={cn(
        'pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-floating',
        // A failed open has only its error to show.
        failed && 'h-auto',
        panel.minimized && 'hidden'
      )}
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        ...(failed ? {} : { height: bounds.height })
      }}
    >
      <header
        className={cn(
          'flex h-9 shrink-0 items-center gap-2 border-b border-border px-3',
          !maximized && 'cursor-grab active:cursor-grabbing'
        )}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        onDoubleClick={(event) => {
          const target = event.target
          if (target instanceof HTMLElement && !target.closest('button')) {
            toggleMaximized()
          }
        }}
      >
        <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 shrink-[2] truncate text-sm font-semibold">
          {translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
            host: panel.label
          })}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
          <HeaderIconButton
            label={translate('auto.components.plainSshTerminal.minimize', 'Minimize')}
            onClick={() => minimizePlainSshPanel(panel.targetId)}
          >
            <Minus />
          </HeaderIconButton>
          <HeaderIconButton
            label={
              maximized
                ? translate('auto.components.plainSshTerminal.restore', 'Restore')
                : translate('auto.components.plainSshTerminal.maximize', 'Maximize')
            }
            onClick={toggleMaximized}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </HeaderIconButton>
          <HeaderIconButton
            label={translate('auto.components.plainSshTerminal.close', 'Close and end session')}
            onClick={() => removePlainSshPanel(panel.targetId)}
          >
            <X />
          </HeaderIconButton>
        </div>
      </header>
      <p className="border-b border-border bg-muted px-3 py-1.5 text-xs text-status-warning">
        {plainSshUnmanagedNotice()}
      </p>
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
          hidden={panel.minimized}
          onPhase={setPhase}
          sessionKey={`plain-ssh:${panel.targetId}`}
          onCleanExit={() => removePlainSshPanel(panel.targetId)}
        />
      </div>
      {!maximized && !panel.minimized ? (
        <FloatingTerminalResizeHandles
          bounds={bounds}
          onPreviewBounds={(next) => setBounds(clampFloatingTerminalBounds(next))}
          onCommitBounds={() => setBounds((current) => clampFloatingTerminalBounds(current))}
        />
      ) : null}
    </section>
  )
}

/**
 * `surfaceOnly` renders one direct-host panel for the workbench portal (tab strip lives in the
 * titlebar); the default renders the legacy escape-hatch cards, which keep their own chrome.
 */
export function PlainSshTerminalPanels({
  surfaceOnly = false,
  targetId
}: {
  surfaceOnly?: boolean
  targetId?: string
}): React.JSX.Element | null {
  const panels = usePlainSshPanels()
  if (surfaceOnly) {
    const panel = panels.find((entry) => entry.targetId === targetId && entry.direct)
    return panel ? <DirectSshSurfacePanel panel={panel} /> : null
  }
  const legacy = panels.filter((panel) => !panel.direct)
  if (legacy.length === 0) {
    return null
  }
  const minimized = legacy.filter((panel) => panel.minimized)
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {legacy.map((panel) => (
        <PlainSshTerminalCard key={panel.targetId} panel={panel} />
      ))}
      {minimized.length > 0 ? (
        <div className="pointer-events-auto absolute right-4 bottom-4 flex flex-wrap justify-end gap-2">
          {minimized.map((panel) => (
            <Button
              key={panel.targetId}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => showPlainSshPanel(panel.targetId, panel.label)}
            >
              <SquareTerminal />
              {translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
                host: panel.label
              })}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
