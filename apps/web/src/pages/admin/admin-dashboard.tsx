import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  BotIcon,
  Building2Icon,
  CircleAlertIcon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  UsersIcon,
  WalletCardsIcon,
  WorkflowIcon,
} from 'lucide-react'
import { getAdminAnalytics, listAdminUsers } from '@/shared/api/api'
import type { AdminActivityDay, AdminAnalytics, AdminUser } from '@/shared/lib/types'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { changeFrom, formatMetric, formatTokens, relativeTime } from '@/features/admin/lib/admin-format'
import { OrganizationBadges } from '@/features/admin/components/organization-badges'
import { cn } from '@/shared/lib/utils'

const PERIODS = [7, 30, 90] as const

export function AdminDashboard() {
  const [days, setDays] = useState<number>(30)
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let live = true
    setLoading(true)
    setError(null)
    Promise.all([getAdminAnalytics(days), listAdminUsers({ limit: 6 })])
      .then(([nextAnalytics, nextUsers]) => {
        if (!live) return
        setAnalytics(nextAnalytics)
        setUsers(nextUsers.users)
      })
      .catch((cause) => live && setError((cause as Error).message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [days])

  useEffect(() => load(), [load])

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="grid w-full gap-7 p-5 md:p-8 xl:gap-9 xl:p-10">
        <header className="flex flex-col gap-5 border-b pb-7 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="readout text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Live platform ledger</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl xl:text-5xl">SaaS activity, end to end.</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
              Every registered user, conversation, run, and provider-reported token—whether the user belongs to an organization or works independently.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border p-1" aria-label="Activity period">
              {PERIODS.map((period) => (
                <button
                  key={period}
                  type="button"
                  aria-pressed={days === period}
                  onClick={() => setDays(period)}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    days === period ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {period}d
                </button>
              ))}
            </div>
            <Button variant="outline" size="lg" onClick={load} disabled={loading}>
              {loading ? <Spinner /> : <RefreshCwIcon />} Refresh
            </Button>
          </div>
        </header>

        {error ? (
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <CircleAlertIcon className="size-5" />
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="outline" onClick={load}>Retry</Button>
          </div>
        ) : null}

        <section aria-label="Platform totals" className="grid overflow-hidden rounded-xl border bg-card sm:grid-cols-2 xl:grid-cols-6">
          <LedgerMetric icon={UsersIcon} label="Registered users" value={analytics?.totals.users} loading={loading} />
          <LedgerMetric icon={MessageSquareTextIcon} label="Conversations" value={analytics?.totals.conversations} loading={loading} />
          <LedgerMetric icon={WorkflowIcon} label="Agent runs" value={analytics?.totals.runs} loading={loading} />
          <LedgerMetric icon={WalletCardsIcon} label="Total tokens" value={analytics ? analytics.totals.tokensIn + analytics.totals.tokensOut : undefined} loading={loading} />
          <LedgerMetric icon={BotIcon} label="Workspaces" value={analytics?.totals.workspaces} loading={loading} />
          <LedgerMetric icon={Building2Icon} label="Organizations" value={analytics?.totals.organizations} loading={loading} />
        </section>

        <section className="overflow-hidden rounded-xl border bg-card">
          <SectionHeader
            eyebrow={`${days}-day signal`}
            title="Activity pulse"
            detail="Runs and provider token load, day by day"
            action={<Link to="/admin/runs" className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline">Open run monitor <ArrowRightIcon className="size-4" /></Link>}
          />
          {analytics ? <ActivityPulse days={analytics.daily} /> : <LoadingBlock />}
          {analytics ? <PeriodStrip analytics={analytics} /> : null}
        </section>

        <div className="grid gap-7 xl:grid-cols-[minmax(0,1.25fr)_minmax(24rem,0.75fr)]">
          <section className="overflow-hidden rounded-xl border bg-card">
            <SectionHeader eyebrow="Accounts" title="Most recently active" detail={`${analytics?.totals.users ?? 0} registered users`} action={<Link to="/admin/users" className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline">All users <ArrowRightIcon className="size-4" /></Link>} />
            {loading && users.length === 0 ? <LoadingBlock /> : users.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">No users have registered yet.</p>
            ) : (
              <div className="divide-y">
                {users.map((user) => <ActiveUserRow key={user.userId} user={user} />)}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border bg-card">
            <SectionHeader eyebrow="Provider mix" title="Models in use" detail={`${days}-day totals`} />
            {analytics ? <ModelLedger analytics={analytics} /> : <LoadingBlock />}
          </section>
        </div>
      </div>
    </main>
  )
}

function LedgerMetric({ icon: Icon, label, value, loading }: { icon: typeof UsersIcon; label: string; value?: number; loading: boolean }) {
  return (
    <div className="min-h-32 border-b p-5 sm:nth-[odd]:border-r xl:border-r xl:border-b-0 xl:last:border-r-0">
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="size-4" /> {label}</div>
      <div className="readout mt-6 text-3xl font-medium tracking-[-0.05em] text-foreground xl:text-[2rem]">
        {loading && value == null ? <Spinner className="size-5" /> : formatMetric(value ?? 0)}
      </div>
    </div>
  )
}

function SectionHeader({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-end">
      <div>
        <p className="readout text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="text-sm text-muted-foreground sm:ml-3">{detail}</p>
      {action ? <div className="sm:ml-auto">{action}</div> : null}
    </div>
  )
}

function ActivityPulse({ days }: { days: AdminActivityDay[] }) {
  const maxRuns = Math.max(1, ...days.map((day) => day.runs))
  const maxTokens = Math.max(1, ...days.map((day) => day.tokensIn + day.tokensOut))
  return (
    <div className="overflow-x-auto px-5 pt-6">
      <div className="flex h-56 min-w-[46rem] items-end gap-1.5" role="img" aria-label="Daily activity chart">
        {days.map((day, index) => {
          const tokenHeight = Math.max(day.tokensIn + day.tokensOut > 0 ? 5 : 1, ((day.tokensIn + day.tokensOut) / maxTokens) * 100)
          const runHeight = Math.max(day.runs > 0 ? 7 : 1, (day.runs / maxRuns) * 100)
          return (
            <div key={day.date} className="group relative flex h-full min-w-2 flex-1 items-end justify-center" title={`${day.date}: ${day.runs} runs, ${formatTokens(day.tokensIn, day.tokensOut)}`}>
              <div className="absolute inset-x-0 bottom-0 rounded-t-sm bg-muted transition-colors group-hover:bg-muted-foreground/20" style={{ height: `${tokenHeight}%` }} />
              <div className="relative w-[42%] min-w-1 rounded-t-sm bg-gradient-to-t from-brand-to to-brand-from" style={{ height: `${runHeight}%` }} />
              {(index === 0 || index === days.length - 1) ? <span className="readout absolute -bottom-6 text-[0.65rem] text-muted-foreground">{day.date.slice(5)}</span> : null}
            </div>
          )
        })}
      </div>
      <div className="mt-8 flex items-center gap-5 border-t py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2"><i className="h-2.5 w-2 rounded-sm bg-gradient-to-t from-brand-to to-brand-from" /> Runs</span>
        <span className="flex items-center gap-2"><i className="h-2.5 w-2 rounded-sm bg-muted" /> Token load</span>
      </div>
    </div>
  )
}

function PeriodStrip({ analytics }: { analytics: AdminAnalytics }) {
  const periodTokens = analytics.period.tokensIn + analytics.period.tokensOut
  const previousTokens = analytics.period.previousTokensIn + analytics.period.previousTokensOut
  const errorRate = analytics.period.runs ? (analytics.period.errors / analytics.period.runs) * 100 : 0
  const stats = [
    ['Active users', formatMetric(analytics.period.activeUsers), 'Users who ran an agent'],
    ['Conversations', formatMetric(analytics.period.conversations), 'Distinct threads with runs'],
    ['Runs', formatMetric(analytics.period.runs), changeFrom(analytics.period.runs, analytics.period.previousRuns)],
    ['Tokens', formatMetric(periodTokens), changeFrom(periodTokens, previousTokens)],
    ['Error rate', `${errorRate.toFixed(1)}%`, `${analytics.period.errors} failed runs`],
  ]
  return (
    <div className="grid border-t sm:grid-cols-2 xl:grid-cols-5">
      {stats.map(([label, value, detail]) => (
        <div key={label} className="border-b p-4 sm:border-r xl:border-b-0 xl:last:border-r-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="readout mt-2 text-xl font-medium text-foreground">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </div>
      ))}
    </div>
  )
}

function ActiveUserRow({ user }: { user: AdminUser }) {
  const name = user.displayName || user.email || user.userId
  return (
    <article className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(5rem,0.45fr))_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-base font-semibold">{name}</p>
        <p className="readout mt-1 truncate text-xs text-muted-foreground">{user.email || user.userId}</p>
        <OrganizationBadges organizations={user.organizations} className="mt-2" compact />
      </div>
      <MiniStat label="Runs" value={formatMetric(user.runCount)} />
      <MiniStat label="Conversations" value={formatMetric(user.conversationCount)} />
      <MiniStat label="Tokens" value={formatMetric(user.tokensIn + user.tokensOut)} />
      <div className="flex items-center gap-3 sm:justify-end">
        <span className="hidden text-xs text-muted-foreground xl:inline">{relativeTime(user.lastActiveAt)}</span>
        <Button variant="ghost" size="icon" aria-label={`Inspect ${name}'s runs`} asChild>
          <Link to="/admin/runs" search={{ user: user.userId }}><ArrowRightIcon /></Link>
        </Button>
      </div>
    </article>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="readout mt-1 text-sm font-medium">{value}</p></div>
}

function ModelLedger({ analytics }: { analytics: AdminAnalytics }) {
  const maxRuns = Math.max(1, ...analytics.models.map((model) => model.runs))
  return analytics.models.length ? (
    <div className="divide-y">
      {analytics.models.map((model) => (
        <div key={model.modelId} className="px-5 py-4">
          <div className="flex items-baseline gap-3">
            <p className="readout min-w-0 flex-1 truncate text-sm font-medium">{model.modelId.replace(/^gw-/, '')}</p>
            <p className="readout text-xs text-muted-foreground">{model.runs} runs · {formatTokens(model.tokensIn, model.tokensOut)}</p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground" style={{ width: `${(model.runs / maxRuns) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  ) : <p className="px-5 py-8 text-sm text-muted-foreground">No model activity in this period.</p>
}

function LoadingBlock() {
  return <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading activity…</div>
}
