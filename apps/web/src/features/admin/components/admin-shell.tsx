import { Link, Outlet } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { useMeContext } from '@/features/workspace/hooks/use-me'
import { ADMIN_NAV } from '@/features/admin/lib/admin-navigation'
import type { AdminNavItem } from '@/features/admin/lib/admin-navigation'
import { cn } from '@/shared/lib/utils'

export function AdminShell() {
  const { me, loading } = useMeContext()

  if (loading) {
    return <AdminState icon={<Spinner />} title="Checking administrator access…" />
  }

  if (!me?.canAdministerOrganizations) {
    return (
      <AdminState
        icon={<ShieldCheckIcon />}
        title="Admin panel unavailable"
        description="This area is limited to configured platform administrators."
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex xl:w-72">
        <AdminBrand />
        <nav aria-label="Admin panel" className="grid gap-1 p-3">
          {ADMIN_NAV.map((item) => <AdminNavLink key={item.to} {...item} />)}
        </nav>
        <div className="mt-auto border-t p-3">
          <Button variant="ghost" className="w-full justify-start" asChild>
            <Link to="/">
              <ArrowLeftIcon />
              Back to workspace
            </Link>
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b bg-background md:hidden">
          <div className="flex h-14 items-center gap-2.5 px-4">
            <ShieldCheckIcon className="size-5 text-primary" />
            <span className="text-base font-semibold">Admin panel</span>
            <Button variant="ghost" size="sm" className="ml-auto px-2 sm:px-2.5" asChild>
              <Link to="/"><ArrowLeftIcon /><span className="hidden sm:inline">Workspace</span><span className="sr-only sm:hidden">Back to workspace</span></Link>
            </Button>
          </div>
          <nav aria-label="Admin panel" className="flex gap-1.5 overflow-x-auto border-t px-3 py-2">
            {ADMIN_NAV.map((item) => <AdminNavLink key={item.to} {...item} compact />)}
          </nav>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

function AdminBrand() {
  return (
    <div className="flex h-14 items-center gap-3 border-b px-4">
      <BrandMark className="h-5" />
      <div className="min-w-0">
        <p className="truncate text-base font-semibold">Admin panel</p>
        <p className="truncate text-xs text-muted-foreground">Platform control plane</p>
      </div>
    </div>
  )
}

function AdminNavLink({
  to,
  label,
  icon: Icon,
  compact = false,
}: {
  to: AdminNavItem['to']
  label: AdminNavItem['label']
  icon: AdminNavItem['icon']
  compact?: boolean
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/admin' }}
      className={cn(
        'flex items-center gap-2.5 rounded-md text-[0.9375rem] text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        compact ? 'shrink-0 px-3 py-2 text-sm' : 'px-3 py-2.5',
      )}
      activeProps={{ className: 'bg-accent font-medium text-foreground' }}
    >
      <Icon className={compact ? 'size-4' : 'size-4.5'} />
      {label}
    </Link>
  )
}

function AdminState({
  icon,
  title,
  description,
}: {
  icon: ReactNode
  title: string
  description?: string
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="grid max-w-sm justify-items-center gap-2 text-center">
        <div className="text-muted-foreground [&_svg]:size-5">{icon}</div>
        <h1 className="text-sm font-semibold">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        <Button variant="outline" size="sm" className="mt-2" asChild>
          <Link to="/"><ArrowLeftIcon /> Back to workspace</Link>
        </Button>
      </div>
    </div>
  )
}
