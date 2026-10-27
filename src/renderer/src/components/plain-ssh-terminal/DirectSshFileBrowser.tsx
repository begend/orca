import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Folder, LoaderCircle, Upload, X } from 'lucide-react'
import type {
  DirectSshBrowseResult,
  DirectSshTransferEvent
} from '../../../../shared/direct-ssh-files'
import type { DirEntry } from '@/components/sidebar/remote-file-browser-helpers'
import { RemoteFileBrowserBreadcrumbs } from '@/components/sidebar/RemoteFileBrowserBreadcrumbs'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type BrowserRow = DirEntry & { path: string }

type TransferRow = {
  label: string
  transferred: number
  total: number | null
  error?: string
}

/** Browse and transfer files on a direct SSH host. Pickers, temp paths and promotion live in main;
 * double-click opens folders and starts downloads. */
export function DirectSshFileBrowser({ targetId }: { targetId: string }): React.JSX.Element {
  const api = window.api.directSshFiles
  const [path, setPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [transfers, setTransfers] = useState<Map<string, TransferRow>>(new Map())
  // Why: a slow directory response must not win over the user's newer navigation.
  const loadSeq = useRef(0)

  const applyResult = useCallback((seq: number, result: DirectSshBrowseResult): void => {
    if (loadSeq.current !== seq) {
      return
    }
    setLoading(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPath(result.path)
    setEntries(
      result.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.kind === 'directory'
      }))
    )
  }, [])

  const load = useCallback(
    (dir: string): void => {
      if (!api) {
        return
      }
      const seq = ++loadSeq.current
      setLoading(true)
      setError(null)
      void api
        .list({ targetId, path: dir })
        .then((result) => applyResult(seq, result))
        .catch((err: unknown) => {
          if (loadSeq.current === seq) {
            setLoading(false)
            setError(err instanceof Error ? err.message : String(err))
          }
        })
    },
    [api, applyResult, targetId]
  )

  useEffect(() => {
    if (!api) {
      return
    }
    const seq = ++loadSeq.current
    void api
      .home({ targetId })
      .then((result) => {
        if (result.ok) {
          load(result.path)
        } else {
          applyResult(seq, result)
        }
      })
      .catch((err: unknown) => {
        if (loadSeq.current === seq) {
          setLoading(false)
          setError(err instanceof Error ? err.message : String(err))
        }
      })
  }, [api, applyResult, load, targetId])

  useEffect(() => {
    if (!api) {
      return
    }
    const onEvent = (event: DirectSshTransferEvent): void => {
      setTransfers((current) => {
        const next = new Map(current)
        if (event.kind === 'progress') {
          next.set(event.transferId, {
            label: event.label,
            transferred: event.transferred,
            total: event.total
          })
        } else if (event.kind === 'error') {
          next.set(event.transferId, {
            label: event.label,
            transferred: 0,
            total: null,
            error: event.message
          })
        } else {
          next.delete(event.transferId)
        }
        return next
      })
    }
    return api.onEvent(onEvent)
  }, [api])

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return query ? entries.filter((entry) => entry.name.toLowerCase().includes(query)) : entries
  }, [entries, filter])
  const navigateUp = useCallback(() => {
    if (!path) {
      return
    }
    const trimmed = path.replace(/\/+$/g, '')
    load(trimmed === '' ? '/' : trimmed.replace(/\/[^/]*$/g, '') || '/')
  }, [load, path])
  const startUpload = useCallback(() => {
    if (path && api) {
      void api.upload({ targetId, path })
    }
  }, [api, path, targetId])
  const openEntry = useCallback(
    (entry: BrowserRow): void => {
      if (entry.isDirectory) {
        setFilter('')
        load(entry.path)
      } else if (api) {
        void api.download({ targetId, path: entry.path })
      }
    },
    [api, load, targetId]
  )

  if (!api) {
    return (
      <p className="flex flex-1 items-center justify-center px-4 text-xs text-muted-foreground">
        {translate(
          'auto.components.plainSshTerminal.filesUnavailable',
          'File browsing is not available in this build.'
        )}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 px-2 pb-2">
      <div className="flex items-center gap-1">
        <RemoteFileBrowserBreadcrumbs
          resolvedPath={path ?? '/'}
          pathFlavor="posix"
          loading={loading}
          navigate={load}
          navigateUp={navigateUp}
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto shrink-0"
          disabled={!path || loading}
          onClick={startUpload}
        >
          <Upload />
          {translate('auto.components.plainSshTerminal.upload', 'Upload')}
        </Button>
      </div>
      <input
        type="text"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={translate('auto.components.plainSshTerminal.filter', 'Filter')}
        className="h-7 shrink-0 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div
        data-direct-ssh-file-list
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-background scrollbar-sleek"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4">
            <p className="text-center text-xs text-destructive [overflow-wrap:anywhere]">{error}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-muted-foreground">
              {filter
                ? translate('auto.components.plainSshTerminal.noMatches', 'No matches')
                : translate(
                    'auto.components.sidebar.RemoteFileBrowser.51001182e3',
                    'Empty directory'
                  )}
            </p>
          </div>
        ) : (
          visible.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onDoubleClick={() => openEntry(entry)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                'hover:bg-accent/60'
              )}
            >
              {entry.isDirectory ? (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileTypeIcon
                  filePath={entry.name}
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
      {transfers.size > 0 ? (
        <ul className="flex shrink-0 flex-col gap-1 rounded-md border border-border bg-muted/50 px-2 py-1.5">
          {[...transfers.entries()].map(([transferId, transfer]) => (
            <li key={transferId} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{transfer.label}</span>
              {transfer.error ? (
                <span className="truncate text-destructive [overflow-wrap:anywhere]">
                  {transfer.error}
                </span>
              ) : (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {transfer.total != null && transfer.total > 0
                    ? `${Math.min(100, Math.floor((transfer.transferred / transfer.total) * 100))}%`
                    : formatBytes(transfer.transferred)}
                </span>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={translate(
                  'auto.components.plainSshTerminal.dismissTransfer',
                  'Dismiss'
                )}
                onClick={() => {
                  api.cancel({ transferId })
                  setTransfers((current) => {
                    const next = new Map(current)
                    next.delete(transferId)
                    return next
                  })
                }}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
