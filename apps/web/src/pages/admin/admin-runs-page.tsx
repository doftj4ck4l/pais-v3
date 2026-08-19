import { useEffect, useMemo, useState } from 'react'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { CircleAlertIcon, MessageSquareTextIcon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet'
import { RunBreakdown, RunWaterfall, SpanDetail } from '@/pages/admin/components/run-waterfall'
import { Transcript } from '@/features/agents/components/transcript'
import { itemsFromRows } from '@/features/agents/lib/transcript'
import { getRun, getRunSession, listRuns } from '@/shared/api/api'
import type { RunDetail, RunRow, RunSessionDetail, RunSpan } from '@/shared/lib/types'
import type { RunStatus } from '@/shared/lib/types'
import { formatMetric, formatTokens, relativeTime } from '@/features/admin/lib/admin-format'
import { OrganizationBadges } from '@/features/admin/components/organization-badges'
import { cn } from '@/shared/lib/utils'

const route = getRouteApi('/admin/runs')

const STATUS_STYLE: Record<RunStatus, string> = {
  done: 'bg-emerald-500',
  running: 'bg-sky-500',
  error: 'bg-destructive',
  stopped: 'bg-muted-foreground',
}

function selectedStatus(value: string): RunStatus | undefined {
  return value in STATUS_STYLE ? value as RunStatus : undefined
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
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
  const [sessionRunId, setSessionRunId] = useState<string | null>(null)
  const [session, setSession] = useState<{ runId: string; detail: RunSessionDetail } | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const timer = window.setTimeout(() => {
      listRuns({ limit: 100, query, userId: search.user, status: search.status }, controller.signal)
        .then((result) => {
          if (!live || controller.signal.aborted) return
          setRuns(result.runs)
          setTotal(result.total)
        })
        .catch((cause: unknown) => {
          if (!live || controller.signal.aborted || isAbortError(cause)) return
          setError(cause instanceof Error ? cause.message : 'Could not load runs')
        })
        .finally(() => {
          if (live && !controller.signal.aborted) setLoading(false)
        })
    }, 180)
    return () => {
      live = false
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [query, refreshKey, search.status, search.user])

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    setSpan(null)
    setDetailError(null)
    if (!selectedId) {
      setDetail(null)
      setDetailLoading(false)
      return
    }
    setDetailLoading(true)
    getRun(selectedId, controller.signal)
      .then((next) => live && !controller.signal.aborted && setDetail(next))
      .catch((cause: unknown) => {
        if (!live || controller.signal.aborted || isAbortError(cause)) return
        setDetail(null)
        setDetailError(cause instanceof Error ? cause.message : 'Could not load run details')
      })
      .finally(() => live && !controller.signal.aborted && setDetailLoading(false))
    return () => {
      live = false
      controller.abort()
    }
  }, [selectedId])

  useEffect(() => {
    setSessionRunId(null)
  }, [selectedId])

  useEffect(() => {
    if (!sessionRunId) {
      setSessionLoading(false)
      setSessionError(null)
      return
    }
    const controller = new AbortController()
    setSessionLoading(true)
    setSessionError(null)
    getRunSession(sessionRunId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setSession({ runId: sessionRunId, detail: next })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return
        setSessionError(cause instanceof Error ? cause.message : 'Could not load the session')
      })
      .finally(() => {
        if (!controller.signal.aborted) setSessionLoading(false)
      })
    return () => {
      controller.abort()
    }
  }, [sessionRefreshKey, sessionRunId])

  const visibleDetail = detail?.run.id === selectedId ? detail : null
  const visibleSession = sessionRunId === null
    ? session?.detail ?? null
    : session?.runId === sessionRunId ? session.detail : null

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
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  if (search.run) void navigate({ search: { ...search, run: undefined } })
                }}
                placeholder="Search prompt, user, model…"
                className="h-10 pl-9"
              />
            </div>
            <Select value={search.status ?? 'all'} onValueChange={(value) => void navigate({ search: { ...search, run: undefined, status: selectedStatus(value) } })}>
              <SelectTrigger className="h-10 min-w-36"><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="running">Running</SelectItem><SelectItem value="done">Done</SelectItem><SelectItem value="error">Error</SelectItem><SelectItem value="stopped">Stopped</SelectItem></SelectContent>
            </Select>
            <Button variant="outline" size="lg" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>{loading ? <Spinner /> : <RefreshCwIcon />} Refresh</Button>
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
        <aside className="max-h-[42vh] w-full shrink-0 overflow-y-auto border-b lg:max-h-none lg:w-[28rem] lg:border-r lg:border-b-0 2xl:w-[31rem]">
          {!loading && runs.length === 0 ? <p className="p-6 text-sm leading-6 text-muted-foreground">No runs match these filters.</p> : null}
          <ol>
            {runs.map((run) => <RunListItem key={run.id} run={run} selected={selectedId === run.id} onSelect={() => void navigate({ search: { ...search, run: run.id } })} />)}
          </ol>
          {runs.length < total ? <p className="border-t p-4 text-center text-xs text-muted-foreground">Showing the newest {runs.length} of {formatMetric(total)} runs</p> : null}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {!selectedId ? (
              <div className="grid min-h-72 place-items-center p-8 text-center"><div><p className="text-lg font-semibold">Select a run</p><p className="mt-2 text-sm text-muted-foreground">Its timing waterfall, token load, and tool activity will appear here.</p></div></div>
            ) : detailLoading && !visibleDetail ? (
              <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading run…</div>
            ) : detailError ? (
              <div role="alert" className="p-8 text-sm text-destructive">{detailError}</div>
            ) : visibleDetail ? (
              <>
                <RunDetailHeader detail={visibleDetail} onOpenSession={() => setSessionRunId(visibleDetail.run.id)} />
                <RunBreakdown spans={visibleDetail.spans} totalMs={visibleDetail.run.durationMs} />
                <RunWaterfall spans={visibleDetail.spans} totalMs={visibleDetail.run.durationMs} selectedId={span?.id ?? null} onSelect={(next) => setSpan((previous) => previous?.id === next.id ? null : next)} />
              </>
            ) : null}
          </section>

          {visibleDetail && span ? (
            <aside className="flex h-[22rem] min-h-0 shrink-0 flex-col border-t bg-sidebar/65 shadow-[0_-18px_40px_-32px_rgba(15,23,42,0.45)] sm:h-[25rem]">
              <SpanDetail span={span} onClose={() => setSpan(null)} />
            </aside>
          ) : null}
        </div>
      </div>

      <RunSessionSheet
        open={sessionRunId !== null}
        onOpenChange={(open) => {
          if (!open) setSessionRunId(null)
        }}
        detail={visibleSession}
        loading={sessionLoading}
        error={sessionError}
        onRetry={() => setSessionRefreshKey((value) => value + 1)}
      />
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

function RunDetailHeader({ detail, onOpenSession }: { detail: RunDetail; onOpenSession: () => void }) {
  const run = detail.run
  const identity = run.displayName || run.email || run.userId || 'Unknown user'
  return (
    <div className="border-b px-6 py-6 lg:px-8">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-5">
        <div className="min-w-0">
          <p className="readout text-[0.68rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">Selected run</p>
          <p className="mt-2 max-w-5xl text-lg font-medium leading-7">{run.prompt || '(no prompt)'}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onOpenSession}>
          <MessageSquareTextIcon /> Open session
        </Button>
      </div>
      <OrganizationBadges organizations={run.organizations} className="mt-3 gap-2" />
      <div className="mt-5 grid gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-2 xl:grid-cols-4"><DetailStat label="User" value={identity} /><DetailStat label="Workspace" value={run.workspaceName || 'Unknown'} /><DetailStat label="Tokens" value={formatTokens(run.tokensIn, run.tokensOut)} /><DetailStat label="Duration" value={ms(run.durationMs)} /></div>
      <p className="readout mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{run.modelId.replace(/^gw-/, '')}</span><span>{run.turns} turns</span><span>{run.toolCalls} tool calls</span><span className={run.toolErrors ? 'text-destructive' : ''}>{run.toolErrors} failed</span><span>{run.status}</span></p>
      {run.error ? <p role="alert" className="mt-3 text-sm text-destructive">{run.error}</p> : null}
    </div>
  )
}

function RunSessionSheet({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  onRetry,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: RunSessionDetail | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const items = useMemo(() => detail ? itemsFromRows(detail.messages) : [], [detail])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[min(52rem,72vw)] data-[side=right]:sm:max-w-[52rem]"
      >
        <SheetHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <p className="readout text-[0.68rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Session transcript
          </p>
          <SheetTitle className="mt-1 text-xl leading-7">
            {detail?.conversation.title || 'Loading session…'}
          </SheetTitle>
          <SheetDescription>
            The complete conversation containing this run.
          </SheetDescription>
          {detail ? (
            <p className="readout mt-2 truncate text-[0.68rem] text-muted-foreground">
              {detail.conversation.id} · {detail.conversation.status}
            </p>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-background">
          {loading && !detail ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading session…
            </div>
          ) : error ? (
            <div role="alert" className="grid min-h-64 place-items-center p-8 text-center">
              <div>
                <CircleAlertIcon className="mx-auto size-5 text-destructive" />
                <p className="mt-3 text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>Retry</Button>
              </div>
            </div>
          ) : detail && items.length ? (
            <Transcript items={items} running={false} runSummary={null} />
          ) : detail ? (
            <div className="grid min-h-64 place-items-center p-8 text-center text-sm text-muted-foreground">
              This session has no stored messages.
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="readout mt-1 truncate text-sm font-medium">{value}</p></div>
}
