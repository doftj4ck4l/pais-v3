import { useCallback, useEffect, useState } from 'react'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import {
  RunBreakdown,
  RunWaterfall,
  SpanDetail,
  SpanDetailEmpty,
} from '@/pages/admin/components/run-waterfall'
import { getRun, listRuns } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { RunDetail, RunRow, RunSpan } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'

/**
 * Runs, and where their time went.
 *
 * The selected run lives in the URL rather than in state, so a slow run is a
 * link you can send someone — which is most of the value of having the page at
 * all.
 */

const route = getRouteApi('/admin')

const STATUS_STYLE: Record<string, string> = {
  done: 'bg-emerald-500',
  running: 'bg-sky-500',
  error: 'bg-destructive',
  stopped: 'bg-muted-foreground',
}

function ms(n: number | null): string {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

function when(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function Admin() {
  const scope = useScope()
  const navigate = useNavigate({ from: '/admin' })
  const { run: selectedId } = route.useSearch()

  const [runs, setRuns] = useState<RunRow[]>([])
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [span, setSpan] = useState<RunSpan | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setRuns(await listRuns(scope))
    } catch {
      // A listing failure is not fatal; the page still renders empty.
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Detail follows the URL, so a pasted link loads the same run.
  useEffect(() => {
    let cancelled = false
    setSpan(null)
    if (!selectedId) {
      setDetail(null)
      return
    }
    void getRun(scope, selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
    return () => {
      cancelled = true
    }
  }, [scope, selectedId])

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          Console
        </Link>
        <span className="text-sm font-extrabold tracking-[-0.02em]">Runs</span>
        <span className="readout text-[0.625rem] text-muted-foreground">
          {runs.length} recorded
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          aria-label="Refresh runs"
          className="ml-auto text-muted-foreground"
        >
          {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r">
          {runs.length === 0 && !loading ? (
            <p className="p-4 text-xs text-muted-foreground">
              No runs recorded yet. Send a message in the console and it will appear here.
            </p>
          ) : null}

          <ol className="flex flex-col">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => void navigate({ search: { run: r.id } })}
                  className={cn(
                    'flex w-full flex-col gap-1 border-b px-3 py-2 text-left transition-colors',
                    'hover:bg-accent',
                    selectedId === r.id && 'bg-accent',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        STATUS_STYLE[r.status] ?? 'bg-muted-foreground',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {r.prompt || '(no prompt)'}
                    </span>
                    <span className="readout shrink-0 text-[0.625rem] text-muted-foreground">
                      {ms(r.durationMs)}
                    </span>
                  </span>
                  <span className="readout flex gap-2 text-[0.625rem] text-muted-foreground">
                    <span>{when(r.startedAt)}</span>
                    <span>{r.modelId.replace(/^gw-/, '')}</span>
                    <span>{r.turns} turns</span>
                    <span>{r.tokensIn.toLocaleString()} tok</span>
                    {r.toolErrors > 0 ? (
                      <span className="text-destructive">
                        {r.toolErrors}/{r.toolCalls} tools failed
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        {/* Timeline and span detail sit side by side on a wide screen and stack
            on a narrow one — same tree, only the axis changes, so there is one
            copy of each panel rather than a desktop and a mobile version. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {!selectedId ? (
            <p className="p-4 text-xs text-muted-foreground">
              Pick a run to see where its time went.
            </p>
          ) : !detail ? (
            <p className="p-4 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="border-b px-3 py-2">
                <p className="text-xs">{detail.run.prompt || '(no prompt)'}</p>
                <p className="readout mt-1 flex flex-wrap gap-3 text-[0.625rem] text-muted-foreground">
                  <span>{ms(detail.run.durationMs)}</span>
                  <span>{detail.run.turns} turns</span>
                  <span>{detail.run.tokensIn.toLocaleString()} in</span>
                  <span>{detail.run.tokensOut.toLocaleString()} out</span>
                  <span>{detail.run.modelId.replace(/^gw-/, '')}</span>
                  <span>{detail.run.harnessId}</span>
                  <span className={detail.run.toolErrors > 0 ? 'text-destructive' : ''}>
                    {detail.run.toolCalls} tool calls
                    {detail.run.toolErrors > 0 ? `, ${detail.run.toolErrors} failed` : ''}
                  </span>
                </p>
                {detail.run.error ? (
                  <p className="mt-1 text-[0.625rem] text-destructive">{detail.run.error}</p>
                ) : null}
              </div>

              <RunBreakdown spans={detail.spans} totalMs={detail.run.durationMs} />
              <RunWaterfall
                spans={detail.spans}
                totalMs={detail.run.durationMs}
                selectedId={span?.id ?? null}
                onSelect={(s) => setSpan((prev) => (prev?.id === s.id ? null : s))}
              />
            </>
          )}
          </main>

          {/* Only mounted once a run is loaded: an empty detail column beside
              "pick a run" would be two empty states arguing with each other. */}
          {detail ? (
            <aside
              className={cn(
                'flex min-h-0 shrink-0 flex-col bg-sidebar/50',
                'h-80 border-t lg:h-auto lg:w-[26rem] lg:border-t-0 lg:border-l',
              )}
            >
              {span ? (
                <SpanDetail span={span} onClose={() => setSpan(null)} />
              ) : (
                <SpanDetailEmpty />
              )}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  )
}
