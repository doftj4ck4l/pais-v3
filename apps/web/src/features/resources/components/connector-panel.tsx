import { useCallback, useEffect, useState } from 'react'
import { CalendarIcon, CloudIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import { Spinner } from '@/shared/ui/spinner'
import {
  deleteConnector,
  googleAuthUrl,
  listConnectors,
  syncConnector,
  type ConnectorKind,
  type ConnectorRow,
  type SyncOutcome,
} from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'

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

/**
 * How each connector kind presents. `syncable` is the load-bearing bit: Drive
 * pulls files into the document index and so has a sync button and a doc count,
 * while Calendar backs live agent tools and has neither — its card is just the
 * account and a way to disconnect.
 */
const KIND: Record<ConnectorKind, { label: string; syncable: boolean }> = {
  gdrive: { label: 'Google Drive', syncable: true },
  gcal: { label: 'Google Calendar', syncable: false },
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

  async function connect(kind: ConnectorKind) {
    setProblem(null)
    try {
      window.open(await googleAuthUrl(scope, kind), '_blank', 'noopener')
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
    const consequence = KIND[row.kind].syncable
      ? ` Its ${row.documentCount} indexed document(s) will be removed from this workspace.`
      : ' The agent will lose access to it.'
    if (!window.confirm(`Disconnect ${row.accountEmail ?? 'this account'}?${consequence}`)) {
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

  const googleBlocked = blocked.find((b) => b.kind === 'gdrive' || b.kind === 'gcal')

  const connectButtons = (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => void connect('gdrive')}>
        <CloudIcon data-icon="inline-start" />
        Connect Google Drive
      </Button>
      <Button size="sm" onClick={() => void connect('gcal')}>
        <CalendarIcon data-icon="inline-start" />
        Connect Google Calendar
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col">
      <PanelHeader
        summary={rows.length ? `${rows.length} connected` : null}
        action={rows.length && !googleBlocked ? connectButtons : null}
      />

      <div>
        {rows.length === 0 ? (
          // A blocked connector says what is missing rather than offering a
          // button that fails on click: the fix is in a file on the server, and
          // naming it is the whole help.
          <PanelEmpty
            icon={CloudIcon}
            title={googleBlocked ? 'Connectors are not configured' : 'Nothing connected'}
            description={
              googleBlocked?.reason ??
              'Connect Google Drive to index its files, or Google Calendar to let the agent read and manage your events.'
            }
            action={googleBlocked ? null : connectButtons}
          />
        ) : null}

        <PanelGrid>
          {rows.map((row) => (
            <ItemCard
              key={row.id}
              leading={
                <span
                  aria-hidden
                  className={cn('mt-1.5 size-2 shrink-0 rounded-full', STATUS_STYLE[row.status])}
                />
              }
              title={row.accountEmail ?? KIND[row.kind].label}
              meta={
                <span className="flex flex-wrap gap-x-2">
                  <span>{KIND[row.kind].label}</span>
                  {KIND[row.kind].syncable ? (
                    <>
                      <span>
                        {row.documentCount} doc{row.documentCount === 1 ? '' : 's'}
                      </span>
                      <span>{when(row.lastSyncAt)}</span>
                    </>
                  ) : (
                    <span>agent tools</span>
                  )}
                  {row.error ? <span className="text-destructive">{row.error}</span> : null}
                </span>
              }
              actions={
                <>
                  {KIND[row.kind].syncable ? (
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
                  ) : null}
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
                </>
              }
            />
          ))}
        </PanelGrid>

        {notice ? (
          <p className="readout mt-3 text-muted-foreground">{notice}</p>
        ) : null}
        {problem ? (
          <p className="readout mt-3 whitespace-pre-wrap text-destructive">{problem}</p>
        ) : null}
      </div>

      {googleBlocked && rows.length ? (
        <p className="mt-3 text-xs text-muted-foreground">{googleBlocked.reason}</p>
      ) : null}
    </div>
  )
}
