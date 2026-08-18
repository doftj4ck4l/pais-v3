import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon, UsersIcon } from 'lucide-react'
import { listAdminUsers } from '@/shared/api/api'
import type { AdminUser } from '@/shared/lib/types'
import { formatMetric, formatTokens, relativeTime } from '@/features/admin/lib/admin-format'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { OrganizationBadges } from '@/features/admin/components/organization-badges'

const PAGE_SIZE = 50

export function AdminUsersPage() {
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      listAdminUsers({ limit: PAGE_SIZE, offset, query, signal: controller.signal })
        .then((result) => {
          if (!live) return
          setUsers(result.users)
          setTotal(result.total)
        })
        .catch((cause) => live && (cause as Error).name !== 'AbortError' && setError((cause as Error).message))
        .finally(() => live && setLoading(false))
    }, 350)
    return () => { live = false; controller.abort(); window.clearTimeout(timer) }
  }, [offset, query])

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="grid w-full gap-7 p-5 md:p-8 xl:p-10">
        <header className="flex flex-col gap-5 border-b pb-7 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="readout text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Account ledger</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Users</h1>
            <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">Every persisted account is visible here. Organization membership is context, not a requirement.</p>
          </div>
          <div className="relative w-full lg:w-[26rem]">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0) }} placeholder="Search name, user ID, email, organization…" className="h-11 pl-9 text-base" />
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 rounded-lg border px-4 py-3"><UsersIcon className="size-5 text-muted-foreground" /><span className="readout text-xl font-medium">{formatMetric(total)}</span><span className="text-sm text-muted-foreground">users</span></div>
          <p className="text-sm text-muted-foreground">Email appears only when an organization membership has supplied one.</p>
        </div>

        {error ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}

        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[68rem] text-left">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr><th className="px-5 py-3 font-medium">User</th><th className="px-4 py-3 font-medium">Organization</th><th className="px-4 py-3 text-right font-medium">Workspaces</th><th className="px-4 py-3 text-right font-medium">Conversations</th><th className="px-4 py-3 text-right font-medium">Runs</th><th className="px-4 py-3 text-right font-medium">Tokens</th><th className="px-4 py-3 font-medium">Last active</th><th className="w-14" /></tr>
              </thead>
              <tbody className="divide-y">
                {users.map((user) => <UserTableRow key={user.userId} user={user} />)}
              </tbody>
            </table>
          </div>
          {loading ? <div className="flex items-center justify-center gap-2 border-t px-5 py-6 text-sm text-muted-foreground"><Spinner /> Loading users…</div> : null}
          {!loading && users.length === 0 ? <div className="grid justify-items-center gap-2 px-5 py-14 text-center"><UsersIcon className="size-6 text-muted-foreground" /><p className="font-medium">No users found</p><p className="text-sm text-muted-foreground">Try a different name, ID, email, or organization.</p></div> : null}
        </section>

        <footer className="flex items-center justify-between">
          <p className="readout text-xs text-muted-foreground">Page {page} of {pages}</p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeftIcon /> Previous</Button>
            <Button variant="outline" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>Next <ChevronRightIcon /></Button>
          </div>
        </footer>
      </div>
    </main>
  )
}

function UserTableRow({ user }: { user: AdminUser }) {
  const name = user.displayName || user.email || user.userId
  return (
    <tr className="transition-colors hover:bg-muted/30">
      <td className="px-5 py-4"><p className="max-w-72 truncate text-sm font-semibold">{name}</p><p className="readout mt-1 max-w-72 truncate text-xs text-muted-foreground">{user.email || user.userId}</p></td>
      <td className="px-4 py-4"><OrganizationBadges organizations={user.organizations} className="max-w-64" /></td>
      <NumberCell value={formatMetric(user.workspaceCount)} />
      <NumberCell value={formatMetric(user.conversationCount)} />
      <NumberCell value={formatMetric(user.runCount)} />
      <NumberCell value={formatTokens(user.tokensIn, user.tokensOut)} />
      <td className="px-4 py-4 text-sm text-muted-foreground">{relativeTime(user.lastActiveAt)}</td>
      <td className="pr-3"><Button variant="ghost" size="icon" aria-label={`Inspect ${name}'s runs`} asChild><Link to="/admin/runs" search={{ user: user.userId }}><ArrowRightIcon /></Link></Button></td>
    </tr>
  )
}

function NumberCell({ value }: { value: string }) {
  return <td className="readout px-4 py-4 text-right text-sm">{value}</td>
}
