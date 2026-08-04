import { useCallback, useEffect, useState } from 'react'
import { AlertTriangleIcon, DatabaseIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { addConnection, deleteConnection, listConnections, refreshConnection } from '@/lib/api'
import { getUserId } from '@/lib/user'
import type { DbConnectionRow } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Connect a read-only Postgres database and see what the agent can query.
 *
 * A connection that failed to introspect is listed alongside the ones that
 * worked, carrying its reason — the same stance the document panel takes, and
 * for the same reason: an unreachable database looks exactly like an empty one
 * until the agent says it found nothing.
 */
export function DatabasePanel() {
  const [connections, setConnections] = useState<DbConnectionRow[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setConnections(await listConnections(getUserId()))
    } catch {
      // Secondary to the console; a listing failure is not fatal.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = useCallback(async () => {
    if (!name.trim() || !url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const out = await addConnection(getUserId(), name.trim(), url.trim())
      if (out.error) {
        setError(out.error)
        return
      }
      setName('')
      setUrl('')
      setAdding(false)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [name, url, refresh])

  const connected = connections.filter((c) => c.status === 'connected')
  const tableTotal = connected.reduce((n, c) => n + c.tableCount, 0)

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="label text-muted-foreground">Databases</h2>
        {connected.length ? (
          <span className="readout text-[0.625rem] text-muted-foreground">
            {connected.length} db{connected.length === 1 ? '' : 's'} · {tableTotal} tables
          </span>
        ) : null}
        {busy ? <Spinner className="ml-auto size-3.5 text-muted-foreground" /> : null}
      </div>

      {adding ? (
        <div className="flex flex-col gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name, e.g. sales"
            className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-foreground/30"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="postgres://readonly@host:5432/db"
            className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-foreground/30"
          />
          {error ? <p className="text-[0.625rem] text-muted-foreground">{error}</p> : null}
          <div className="flex gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void submit()} className="flex-1">
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
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

      {connections.length ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {connections.map((c) => (
            <ConnectionItem
              key={c.id}
              connection={c}
              onRefresh={async () => {
                setBusy(true)
                try {
                  await refreshConnection(getUserId(), c.id)
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
              onRemove={async () => {
                setConnections((prev) => prev.filter((x) => x.id !== c.id)) // optimistic
                await deleteConnection(getUserId(), c.id)
                await refresh()
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
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
