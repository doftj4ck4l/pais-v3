import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ActivityIcon,
  ArrowRightIcon,
  Building2Icon,
  ShieldCheckIcon,
  UserRoundIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ADMIN_DESTINATIONS } from '@/features/admin/lib/admin-navigation'
import type { AdminDestination as AdminDestinationItem } from '@/features/admin/lib/admin-navigation'
import { listOrganizations } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import type { OrganizationSummary } from '@/shared/lib/types'

export function AdminDashboard() {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOrganizations = useCallback(() => {
    let live = true
    setLoading(true)
    setError(null)
    listOrganizations()
      .then((rows) => live && setOrganizations(rows))
      .catch((cause) => live && setError((cause as Error).message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [])

  useEffect(() => {
    return loadOrganizations()
  }, [loadOrganizations])

  const totals = useMemo(() => ({
    members: organizations.reduce((sum, row) => sum + row.memberCount, 0),
    pending: organizations.reduce((sum, row) => sum + row.pendingInvitationCount, 0),
  }), [organizations])

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 md:p-6 lg:p-8">
      <div className="grid w-full min-w-0 gap-5">
        <header className="flex flex-col gap-2 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <ShieldCheckIcon className="size-4.5" />
              Platform administration
            </div>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">Control plane</h1>
          </div>
          <p className="min-w-0 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-right">
            Manage people and inspect agent activity across the platform.
          </p>
        </header>

        {error ? (
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="outline" size="sm" onClick={loadOrganizations}>Retry</Button>
          </div>
        ) : null}

        <section aria-label="Organization summary" className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-3 sm:divide-x">
          <Metric icon={Building2Icon} label="Organizations" value={loading ? null : error ? undefined : organizations.length} />
          <Metric icon={UserRoundIcon} label="Memberships" value={loading ? null : error ? undefined : totals.members} />
          <Metric icon={ActivityIcon} label="Pending invitations" value={loading ? null : error ? undefined : totals.pending} />
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(22rem,0.85fr)]">
          <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
            <SectionHeading title="Administration" detail="Choose an operational area" />
            {ADMIN_DESTINATIONS.map((item) => (
              <AdminDestination
                key={item.to}
                icon={item.icon}
                title={item.label}
                description={item.description}
                to={item.to}
                action={item.action}
              />
            ))}
          </section>

          <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
            <SectionHeading title="Organization ledger" detail={`${organizations.length} total`} />
            {loading ? (
              <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground"><Spinner /> Loading…</div>
            ) : error ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">Organization data is unavailable.</p>
            ) : organizations.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">No organizations yet.</p>
            ) : (
              <div className="divide-y">
                {organizations.slice(0, 5).map((organization) => (
                  <div key={organization.id} className="flex items-center gap-3.5 px-4 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      <Building2Icon className="size-4.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{organization.name}</p>
                      <p className="readout mt-1 text-xs text-muted-foreground">
                        {organization.memberCount} members · {organization.pendingInvitationCount} pending
                      </p>
                    </div>
                  </div>
                ))}
                {organizations.length > 5 ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">+{organizations.length - 5} more organizations</p>
                ) : null}
              </div>
            )}
            <div className="border-t p-3">
              <Button variant="ghost" size="sm" className="w-full justify-between" asChild>
                <Link to="/admin/organizations">Open organization manager<ArrowRightIcon /></Link>
              </Button>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number | null | undefined }) {
  return (
    <div className="flex items-center gap-4 border-b px-5 py-4 last:border-b-0 sm:border-b-0">
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Icon className="size-5" /></span>
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="readout mt-1 text-2xl font-medium text-foreground">{value === null ? <Spinner /> : (value ?? '—')}</div>
      </div>
    </div>
  )
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{detail}</span>
    </div>
  )
}

function AdminDestination({
  icon: Icon,
  title,
  description,
  to,
  action,
}: {
  icon: LucideIcon
  title: string
  description: string
  to: AdminDestinationItem['to']
  action: string
}) {
  return (
    <article className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0">
      <div className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Icon className="size-5" /></div>
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 break-words text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" size="sm" className="hidden shrink-0 sm:inline-flex" asChild>
        <Link to={to}>{action}<ArrowRightIcon /></Link>
      </Button>
      <Button variant="ghost" size="icon-sm" className="shrink-0 sm:hidden" aria-label={action} asChild>
        <Link to={to}><ArrowRightIcon /></Link>
      </Button>
    </article>
  )
}
