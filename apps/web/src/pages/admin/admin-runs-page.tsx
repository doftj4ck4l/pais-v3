import { useCallback, useEffect, useState } from 'react'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { CircleAlertIcon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { RunBreakdown, RunWaterfall, SpanDetail, SpanDetailEmpty } from '@/pages/admin/components/run-waterfall'
import { getRun, listRuns } from '@/shared/api/api'
import type { RunDetail, RunRow, RunSpan } from '@/shared/lib/types'
import { formatMetric, formatTokens, relativeTime } from '@/features/admin/lib/admin-format'
import { cn } from '@/shared/lib/utils'

const route = getRouteApi('/admin/runs')

const STATUS_STYLE: Record<string, string> = {
  done: 'bg-emerald-500',
  running: 'bg-sky-500',
  error: 'bg-destructive',
  stopped: 'bg-muted-foreground',
}

function ms(value: number | null): string {
  if (value == null) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
}

export function AdminRunsPage() {
  const navigate = useNavigate({ from: '/admin/runs' })
  const search = route.useSearch()
  const selectedId = search.run
  const [query, setQuery] = useState(search.q ?? '')
  const [runs, setRuns] = useState<RunRow[]>([])
  const [total, setTotal] = useState(0)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [span, setSpan] = useState<RunSpan | null>(null)

  const refresh = useCallback(() => {
    let live = true
    setLoading(true)
    setError(null)
    listRuns({ limit: 100, query, userId: search.user, status: search.status })
      .then((result) => {
        if (!live) return
        setRuns(result.runs)
        setTotal(result.total)
      })
      .catch((cause) => live && setError((cause as Error).message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [query, search.status, search.user])

  useEffect(() => {
    const timer = window.setTimeout(() => refresh(), 180)
    return () => { window.clearTimeout(timer) }
  }, [refresh])

  useEffect(() => {
    let live = true
    setSpan(null)
    setDetailError(null)
    if (!selectedId) {
      setDetail(null)
      setDetailLoading(false)
      return
    }
    setDetailLoading(true)
    getRun(selectedId)
      .then((next) => live && setDetail(next))
      .catch((cause) => {
        if (!live) return
        setDetail(null)
        setDetailError((cause as Error).message)
      })
      .finally(() => live && setDetailLoading(false))
    return () => { live = false }
  }, [selectedId])

  const visibleDetail = detail?.run.id === selectedId ? detail : null

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b px-5 py-5 md:px-8 xl:px-10">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
          <div className="min-w-0 flex-1">
            <p className="readout text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Cross-tenant trace ledger</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em]">Run monitor</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{formatMetric(total)} recorded runs across every user and workspace</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prompt, user, model…" className="h-10 pl-9" />
            </div>
            <Select value={search.status ?? 'all'} onValueChange={(value) => void navigate({ search: { ...search, run: undefined, status: value === 'all' ? undefined : value } })}>
              <SelectTrigger className="h-10 min-w-36"><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="running">Running</SelectItem><SelectItem value="done">Done</SelectItem><SelectItem value="error">Error</SelectItem><SelectItem value="stopped">Stopped</SelectItem></SelectContent>
            </Select>
            <Button variant="outline" size="lg" onClick={refresh} disabled={loading}>{loading ? <Spinner /> : <RefreshCwIcon />} Refresh</Button>
          </div>
        </div>
        {search.user ? (
          <div className="mt-4 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Filtering user</span>
            <span className="readout rounded-md bg-muted px-2 py-1 text-xs">{search.user}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Clear user filter" onClick={() => void navigate({ search: { ...search, user: undefined, run: undefined } })}><XIcon /></Button>
          </div>
        ) : null}
        {error ? <div role="alert" className="mt-4 flex items-center gap-2 text-sm text-destructive"><CircleAlertIcon className="size-4" /> {error}</div> : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="max-h-[42vh] w-full shrink-0 overflow-y-auto border-b lg:max-h-none lg:w-[29rem] lg:border-r lg:border-b-0 xl:w-[34rem]">
          {!loading && runs.length === 0 ? <p className="p-6 text-sm leading-6 text-muted-foreground">No runs match these filters.</p> : null}
          <ol>
            {runs.map((run) => <RunListItem key={run.id} run={run} selected={selectedId === run.id} onSelect={() => void navigate({ search: { ...search, run: run.id } })} />)}
          </ol>
          {runs.length < total ? <p className="border-t p-4 text-center text-xs text-muted-foreground">Showing the newest {runs.length} of {formatMetric(total)} runs</p> : null}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row">
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {!selectedId ? (
              <div className="grid min-h-72 place-items-center p-8 text-center"><div><p className="text-lg font-semibold">Select a run</p><p className="mt-2 text-sm text-muted-foreground">Its timing waterfall, token load, and tool activity will appear here.</p></div></div>
            ) : detailLoading && !visibleDetail ? (
              <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading run…</div>
            ) : detailError ? (
              <div role="alert" className="p-8 text-sm text-destructive">{detailError}</div>
            ) : visibleDetail ? (
              <>
                <RunDetailHeader detail={visibleDetail} />
                <RunBreakdown spans={visibleDetail.spans} totalMs={visibleDetail.run.durationMs} />
                <RunWaterfall spans={visibleDetail.spans} totalMs={visibleDetail.run.durationMs} selectedId={span?.id ?? null} onSelect={(next) => setSpan((previous) => previous?.id === next.id ? null : next)} />
              </>
            ) : null}
          </section>

          {visibleDetail ? (
            <aside className="flex h-80 min-h-0 shrink-0 flex-col border-t bg-sidebar/50 xl:h-auto xl:w-[30rem] xl:border-t-0 xl:border-l">
              {span ? <SpanDetail span={span} onClose={() => setSpan(null)} /> : <SpanDetailEmpty />}
            </aside>
          ) : null}
        </div>
      </div>
    </main>
  )
}

function RunListItem({ run, selected, onSelect }: { run: RunRow; selected: boolean; onSelect: () => void }) {
  const identity = run.displayName || run.email || run.userId || 'Unknown user'
  return (
    <li>
      <button type="button" aria-pressed={selected} onClick={onSelect} className={cn('w-full border-b px-5 py-4 text-left transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none', selected && 'bg-accent')}>
        <div className="flex items-start gap-3">
          <span className={cn('mt-2 size-2 shrink-0 rounded-full', STATUS_STYLE[run.status] ?? 'bg-muted-foreground')} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-5">{run.prompt || '(no prompt)'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="font-medium text-foreground">{identity}</span><span>{run.workspaceName || 'Unknown workspace'}</span><span>{relativeTime(run.startedAt)}</span></div>
            <div className="readout mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-muted-foreground"><span>{run.modelId.replace(/^gw-/, '')}</span><span>{formatTokens(run.tokensIn, run.tokensOut)}</span><span>{run.turns} turns</span><span>{ms(run.durationMs)}</span>{run.toolErrors ? <span className="text-destructive">{run.toolErrors} tool errors</span> : null}</div>
          </div>
        </div>
      </button>
    </li>
  )
}

function RunDetailHeader({ detail }: { detail: RunDetail }) {
  const run = detail.run
  const identity = run.displayName || run.email || run.userId || 'Unknown user'
  return (
    <div className="border-b px-6 py-5">
      <p className="text-base font-medium leading-6">{run.prompt || '(no prompt)'}</p>
      <div className="mt-3 flex flex-wrap gap-2">{run.organizations.length ? run.organizations.map((organization) => <span key={organization.id} className="rounded-md bg-muted px-2 py-1 text-xs">{organization.name}</span>) : <span className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">Independent</span>}</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><DetailStat label="User" value={identity} /><DetailStat label="Workspace" value={run.workspaceName || 'Unknown'} /><DetailStat label="Tokens" value={formatTokens(run.tokensIn, run.tokensOut)} /><DetailStat label="Duration" value={ms(run.durationMs)} /></div>
      <p className="readout mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{run.modelId.replace(/^gw-/, '')}</span><span>{run.turns} turns</span><span>{run.toolCalls} tool calls</span><span className={run.toolErrors ? 'text-destructive' : ''}>{run.toolErrors} failed</span><span>{run.status}</span></p>
      {run.error ? <p role="alert" className="mt-3 text-sm text-destructive">{run.error}</p> : null}
    </div>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="readout mt-1 truncate text-sm font-medium">{value}</p></div>
}
