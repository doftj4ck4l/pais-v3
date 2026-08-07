import { useCallback, useEffect, useState } from 'react'
import { CloudIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  deleteConnector,
  googleAuthUrl,
  listConnectors,
  syncConnector,
  type ConnectorRow,
  type SyncOutcome,
} from '@/lib/api'
import { useScope } from '@/hooks/use-workspace'
import { cn } from '@/lib/utils'

/**
 * Remote sources that sync into this workspace's documents.
 *
 * Consent happens in a second tab, not in this one: Google refuses to render
 * its consent screen in an iframe, and navigating away from the console would
 * lose whatever run is in flight. The tab closes itself out of the flow — this
 * panel just polls once the user comes back.
 */

const STATUS_STYLE: Record<ConnectorRow['status'], string> = {
  connected: 'bg-emerald-500',
  syncing: 'bg-sky-500',
  error: 'bg-destructive',
}

function when(ts: number | null): string {
  if (!ts) return 'never synced'
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'synced just now'
  if (mins < 60) return `synced ${mins}m ago`
  return `synced ${Math.round(mins / 60)}h ago`
}

/** One line summarising what a sync did, in the order a person cares about. */
function summarise(out: SyncOutcome): string {
  const parts: string[] = []
  if (out.indexed) parts.push(`${out.indexed} added`)
  if (out.updated) parts.push(`${out.updated} updated`)
  if (out.removed) parts.push(`${out.removed} removed`)
  if (out.unchanged) parts.push(`${out.unchanged} unchanged`)
  if (out.skipped.length) parts.push(`${out.skipped.length} skipped`)
  if (out.failed.length) parts.push(`${out.failed.length} failed`)
  return parts.length ? parts.join(' · ') : 'nothing to do'
}

export function ConnectorPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const scope = useScope()
  const [rows, setRows] = useState<ConnectorRow[]>([])
  const [blocked, setBlocked] = useState<{ kind: string; reason: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { connectors, available } = await listConnectors(scope)
      setRows(connectors)
      setBlocked(available)
      onCountChange?.(connectors.length)
    } catch (e) {
      setProblem((e as Error).message)
    }
  }, [scope, onCountChange])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The consent tab cannot talk back to this one, so the panel re-reads when
  // the window regains focus. That is the moment the user has finished with it.
  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  async function connect() {
    setProblem(null)
    try {
      window.open(await googleAuthUrl(scope), '_blank', 'noopener')
      setNotice('Finish in the other tab, then come back.')
    } catch (e) {
      setProblem((e as Error).message)
    }
  }

  async function sync(id: string) {
    setBusy(id)
    setProblem(null)
    setNotice(null)
    try {
      const out = await syncConnector(scope, id)
      setNotice(summarise(out))
      // Failures are per-file and the sync still succeeded, so they surface as
      // detail rather than as an error that hides what did work.
      if (out.failed.length) {
        setProblem(out.failed.map((f) => `${f.title}: ${f.reason}`).join('\n'))
      }
      await refresh()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function disconnect(row: ConnectorRow) {
    if (
      !window.confirm(
        `Disconnect ${row.accountEmail ?? 'this account'}? Its ${row.documentCount} indexed ` +
          `document(s) will be removed from this workspace.`,
      )
    ) {
      return
    }
    setBusy(row.id)
    try {
      await deleteConnector(scope, row.id)
      setNotice(null)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const googleBlocked = blocked.find((b) => b.kind === 'gdrive')

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            Connect a source and its files become searchable alongside your uploads.
          </p>
        ) : null}

        <ol className="flex flex-col">
          {rows.map((row) => (
            <li key={row.id} className="border-b px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_STYLE[row.status])} />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {row.accountEmail ?? 'Google Drive'}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void sync(row.id)}
                  disabled={busy === row.id}
                  aria-label="Sync now"
                  className="text-muted-foreground"
                >
                  {busy === row.id ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void disconnect(row)}
                  disabled={busy === row.id}
                  aria-label="Disconnect"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2Icon />
                </Button>
              </div>
              <p className="readout mt-0.5 flex gap-2 pl-3 text-[0.625rem] text-muted-foreground">
                <span>Google Drive</span>
                <span>
                  {row.documentCount} doc{row.documentCount === 1 ? '' : 's'}
                </span>
                <span>{when(row.lastSyncAt)}</span>
              </p>
              {row.error ? (
                <p className="mt-0.5 pl-3 text-[0.625rem] text-destructive">{row.error}</p>
              ) : null}
            </li>
          ))}
        </ol>

        {notice ? (
          <p className="readout px-3 py-2 text-[0.625rem] text-muted-foreground">{notice}</p>
        ) : null}
        {problem ? (
          <p className="readout px-3 py-2 text-[0.625rem] whitespace-pre-wrap text-destructive">
            {problem}
          </p>
        ) : null}
      </div>

      <div className="border-t px-3 py-2">
        {googleBlocked ? (
          // Says what is missing rather than showing a button that fails on
          // click — the fix is in a file, and naming it is the whole help.
          <p className="text-[0.625rem] text-muted-foreground">{googleBlocked.reason}</p>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void connect()} className="w-full gap-1.5">
            <CloudIcon data-icon="inline-start" />
            Connect Google Drive
          </Button>
        )}
      </div>
    </div>
  )
}
