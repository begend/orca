import { useState } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getTabRootStateClasses,
  getTabStripBorderClasses
} from '@/components/tab-bar/drop-indicator'
import {
  PLAIN_SSH_FILES_TAB_ID,
  addPlainSshPanelTab,
  closePlainSshPanelTab,
  setActivePlainSshPanelTab,
  setPlainSshPanelTabTitle,
  type PlainSshPanel,
  type PlainSshPanelTab
} from '@/ssh/plain-ssh-terminal-panels'

const CLOSE_TAB_KEY = 'auto.components.plainSshTerminal.closeTab'
const RENAME_TAB_KEY = 'auto.components.tab.bar.SortableTab.ab19f603eb'
const CHANGE_TITLE_KEY = 'auto.components.tab.bar.SortableTabContextMenu.2f697b3c31'

function DirectSshTab({
  panel,
  tab,
  index,
  active
}: {
  panel: PlainSshPanel
  tab: PlainSshPanelTab
  index: number
  active: boolean
}): React.JSX.Element {
  const title =
    tab.customTitle ??
    `${translate('auto.components.plainSshTerminal.terminalTab', 'Terminal')} ${index + 1}`
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const openRename = (): void => {
    setRenameValue(tab.customTitle ?? title)
    setEditing(true)
  }
  const commitRename = (): void => {
    const trimmed = renameValue.trim()
    setPlainSshPanelTabTitle(panel.targetId, tab.id, trimmed.length > 0 ? trimmed : null)
    setEditing(false)
  }
  const cancelRename = (): void => setEditing(false)

  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={active}
          data-plain-ssh-tab={tab.id}
          data-tab-title={title}
          data-active={active ? 'true' : 'false'}
          className={`group relative flex h-full cursor-pointer select-none items-center px-1.5 text-xs outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(true)} ${getTabRootStateClasses(active)}`}
          onDoubleClick={(event) => {
            if (editing) {
              return
            }
            event.stopPropagation()
            openRename()
          }}
          onClick={() => setActivePlainSshPanelTab(panel.targetId, tab.id)}
        >
          {active ? <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden /> : null}
          {editing ? (
            <Input
              autoFocus
              data-tab-rename-input="true"
              value={renameValue}
              aria-label={translate(RENAME_TAB_KEY, 'Rename tab {{value0}}', { value0: title })}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={commitRename}
              // Why: stop bubbling so clicking inside the input doesn't activate the tab.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (isImeCompositionKeyDown(event)) {
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                }
              }}
              className="mr-1 h-5 min-w-[72px] flex-1 px-1 py-0 text-xs"
              spellCheck={false}
            />
          ) : (
            <span className="max-w-40 truncate">{title}</span>
          )}
          {!editing ? (
            <button
              type="button"
              className={`relative z-10 flex size-4 shrink-0 items-center justify-center rounded-sm ${
                active
                  ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'text-transparent group-hover:text-muted-foreground hover:!bg-muted hover:!text-foreground'
              }`}
              aria-label={translate(CLOSE_TAB_KEY, 'Close tab')}
              data-tab-close-button="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                closePlainSshPanelTab(panel.targetId, tab.id)
              }}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            setMenuOpen(false)
            openRename()
          }}
        >
          {translate(CHANGE_TITLE_KEY, 'Change Title')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Direct-host terminal tabs (plus the Files pseudo-tab) appended to the workspace tab strip. */
export function PlainSshTabItems({ panel }: { panel: PlainSshPanel }): React.JSX.Element {
  const filesAvailable = Boolean(window.api.directSshFiles)
  return (
    <>
      {panel.tabs.map((tab, index) => (
        <DirectSshTab
          key={tab.id}
          panel={panel}
          tab={tab}
          index={index}
          active={panel.selectedTabId === tab.id}
        />
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="mx-0.5 my-auto"
            aria-label={translate('auto.components.plainSshTerminal.newTab', 'New terminal')}
            onClick={() => addPlainSshPanelTab(panel.targetId)}
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
              variant={panel.selectedTabId === PLAIN_SSH_FILES_TAB_ID ? 'secondary' : 'ghost'}
              role="tab"
              aria-selected={panel.selectedTabId === PLAIN_SSH_FILES_TAB_ID}
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
    </>
  )
}
