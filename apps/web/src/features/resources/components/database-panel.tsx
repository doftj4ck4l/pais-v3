import { useCallback, useEffect, useState } from 'react'
import { AlertTriangleIcon, DatabaseIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  addConnectionStreaming,
  deleteConnection,
  listConnections,
  refreshConnection,
  type AttachPhase,
} from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { DbConnectionRow } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'

/**
 * Connect a read-only Postgres database and see what the agent can query.
 *
 * A connection that failed to introspect is listed alongside the ones that
 * worked, carrying its reason — the same stance the document panel takes, and
 * for the same reason: an unreachable database looks exactly like an empty one
 * until the agent says it found nothing.
 */
export function DatabasePanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [connections, setConnections] = useState<DbConnectionRow[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => onCountChange?.(connections.length), [connections.length, onCountChange])
  const [steps, setSteps] = useState<AttachPhase[]>([])
  const scope = useScope()

  const refresh = useCallback(async () => {
    try {
      setConnections(await listConnections(scope))
    } catch {
      // Secondary to the console; a listing failure is not fatal.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = useCallback(async () => {
    if (!name.trim() || !url.trim()) return
    setBusy(true)
    setError(null)
    setSteps([])
    try {
      const out = await addConnectionStreaming(scope, name.trim(), url.trim(), (p) =>
        setSteps((prev) => [...prev, p]),
      )
      if (out.error) {
        setError(out.error)
        // Drop the credential, keep the name: a rejection here is a bad
        // name, a duplicate name, or a missing server config, so the user
        // is more likely correcting the name than retyping the password.
        // The url must not sit in a live input for as long as the panel
        // stays mounted.
        setUrl('')
        return
      }
      setName('')
      setUrl('')
      setAdding(false)
      await refresh()
    } catch {
      setError('Could not reach the API')
    } finally {
      setBusy(false)
      // Deliberately NOT cleared here. A local attach finishes in ~20ms, so
      // clearing on completion would mean the user never sees the steps at all
      // — the log survives until the next attach or an explicit cancel, leaving
      // a record of what just happened above the row it produced.
    }
  }, [name, url, refresh, scope])

  const connected = connections.filter((c) => c.status === 'connected')
  const tableTotal = connected.reduce((n, c) => n + c.tableCount, 0)

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        {connected.length ? (
          <span className="readout text-[0.625rem] text-muted-foreground">
            {connected.length} db{connected.length === 1 ? '' : 's'} · {tableTotal} tables
          </span>
        ) : null}
        {busy ? <Spinner className="ml-auto size-3.5 text-muted-foreground" /> : null}
      </div>

      {adding ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name, e.g. sales"
            aria-label="Connection name"
            className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-foreground/30"
          />
          <input
            type="password"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="postgres://readonly@host:5432/db"
            aria-label="PostgreSQL connection URL"
            className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-foreground/30"
          />
          {error ? <p className="text-[0.625rem] text-muted-foreground">{error}</p> : null}
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={busy} className="flex-1">
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setError(null)
                setName('')
                setUrl('')
                setSteps([])
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2.5',
            'text-xs text-muted-foreground transition-colors',
            'hover:border-foreground/30 hover:text-foreground',
          )}
        >
          <PlusIcon className="size-3.5" />
          Connect a read-only database
        </button>
      )}

      {steps.length ? (
        <div className="mt-2">
          <AttachLog steps={steps} />
        </div>
      ) : null}

      {connections.length ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {connections.map((c) => (
            <ConnectionItem
              key={c.id}
              connection={c}
              onRefresh={async () => {
                setBusy(true)
                try {
                  await refreshConnection(scope, c.id)
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
              onRemove={async () => {
                setConnections((prev) => prev.filter((x) => x.id !== c.id)) // optimistic
                await deleteConnection(scope, c.id)
                await refresh()
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** One line per phase, in the order the server reported them. */
function describe(p: AttachPhase): string {
  switch (p.phase) {
    case 'connected':
      return 'connected'
    case 'catalog':
      return `${CATALOG_LABEL[p.step] ?? p.step} · ${p.count.toLocaleString()}`
    case 'building':
      return `${p.tables.toLocaleString()} tables · ${p.columns.toLocaleString()} columns`
    case 'indexing':
      return `indexing ${p.entries.toLocaleString()} entries`
    case 'done':
      return `ready in ${p.ms.toLocaleString()}ms`
    case 'failed':
      return `${p.step} failed — ${p.error}`
  }
}

const CATALOG_LABEL: Record<string, string> = {
  tables: 'tables',
  columns: 'columns',
  primaryKeys: 'primary keys',
  foreignKeys: 'foreign keys',
  indexes: 'indexes',
}

/**
 * The attach, step by step.
 *
 * Introspection is five sequential round trips plus a write, and against a
 * remote database that is long enough for a spinner to read as a hang. Showing
 * the steps also means a failure names the phase it died on — "reading foreign
 * keys failed" is actionable in a way that one opaque error string is not.
 */
function AttachLog({ steps }: { steps: AttachPhase[] }) {
  const last = steps[steps.length - 1]
  const settled = last?.phase === 'done' || last?.phase === 'failed'

  return (
    <ul className="readout flex flex-col gap-0.5 rounded-md border bg-muted/30 px-2 py-1.5 text-[0.625rem]">
      {steps.map((p, i) => {
        const isLast = i === steps.length - 1
        const failed = p.phase === 'failed'
        // Everything before the tail is finished by definition; only the tail
        // can still be in flight.
        const glyph = failed ? '×' : isLast && !settled ? '▸' : '✓'
        return (
          <li
            key={i}
            className={cn(
              'flex gap-1.5 tabular-nums',
              failed ? 'text-foreground' : 'text-muted-foreground',
              isLast && !settled && 'text-foreground',
            )}
          >
            <span aria-hidden className="w-2 shrink-0">
              {glyph}
            </span>
            <span className="min-w-0 break-words">{describe(p)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ConnectionItem({
  connection,
  onRefresh,
  onRemove,
}: {
  connection: DbConnectionRow
  onRefresh: () => Promise<void>
  onRemove: () => Promise<void>
}) {
  const failed = connection.status !== 'connected'
  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      {failed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{connection.error ?? 'unreachable'}</TooltipContent>
        </Tooltip>
      ) : (
        <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}

      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-xs', failed && 'text-muted-foreground')}>
          {connection.name}
        </span>
        <span className="readout block truncate text-[0.625rem] text-muted-foreground">
          {failed
            ? 'could not connect'
            : `${connection.displayDatabase} @ ${connection.displayHost} · ${connection.tableCount} tables`}
        </span>
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onRefresh()}
        aria-label={`Refresh ${connection.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <RefreshCwIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onRemove()}
        aria-label={`Remove ${connection.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2Icon />
      </Button>
    </li>
  )
}
