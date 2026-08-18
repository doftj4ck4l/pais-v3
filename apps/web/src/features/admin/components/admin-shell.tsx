import { useState } from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { useMeContext } from '@/features/workspace/hooks/use-me'
import { ADMIN_NAV } from '@/features/admin/lib/admin-navigation'
import type { AdminNavItem } from '@/features/admin/lib/admin-navigation'
import { cn } from '@/shared/lib/utils'

export function AdminShell() {
  const { me, loading } = useMeContext()
  const [collapsed, setCollapsed] = useState(true)

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
      <aside className={cn('hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 motion-reduce:transition-none md:flex', collapsed ? 'w-16' : 'w-64 xl:w-72')}>
        <AdminBrand collapsed={collapsed} />
        <nav aria-label="Admin panel" className={cn('grid gap-1', collapsed ? 'p-2' : 'p-3')}>
          {ADMIN_NAV.map((item) => <AdminNavLink key={item.to} {...item} collapsed={collapsed} />)}
        </nav>
        <div className={cn('mt-auto grid gap-1 border-t', collapsed ? 'p-2' : 'p-3')}>
          <AdminRailAction
            collapsed={collapsed}
            label={collapsed ? 'Expand admin navigation' : 'Collapse admin navigation'}
            icon={collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon}
            onClick={() => setCollapsed((value) => !value)}
          />
          <AdminWorkspaceLink collapsed={collapsed} />
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

function AdminBrand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex h-14 items-center border-b', collapsed ? 'justify-center px-2' : 'gap-3 px-4')}>
      <BrandMark className="h-5 shrink-0" />
      {!collapsed ? (
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">Admin panel</p>
          <p className="truncate text-xs text-muted-foreground">Platform control plane</p>
        </div>
      ) : null}
    </div>
  )
}

function AdminNavLink({
  to,
  label,
  icon: Icon,
  compact = false,
  collapsed = false,
}: {
  to: AdminNavItem['to']
  label: AdminNavItem['label']
  icon: AdminNavItem['icon']
  compact?: boolean
  collapsed?: boolean
}) {
  const link = (
    <Link
      to={to}
      aria-label={collapsed ? label : undefined}
      activeOptions={{ exact: to === '/admin' }}
      className={cn(
        'flex items-center gap-2.5 rounded-md text-[0.9375rem] text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        compact ? 'shrink-0 px-3 py-2 text-sm' : collapsed ? 'h-10 justify-center px-0' : 'px-3 py-2.5',
      )}
      activeProps={{ className: 'bg-accent font-medium text-foreground' }}
    >
      <Icon className={compact ? 'size-4' : 'size-4.5'} />
      {!collapsed ? label : null}
    </Link>
  )

  if (!collapsed) return link
  return <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right" sideOffset={6}>{label}</TooltipContent></Tooltip>
}

function AdminRailAction({
  collapsed,
  label,
  icon: Icon,
  onClick,
}: {
  collapsed: boolean
  label: string
  icon: typeof PanelLeftOpenIcon
  onClick: () => void
}) {
  const action = (
    <Button variant="ghost" className={cn('w-full', collapsed ? 'h-10 justify-center px-0' : 'justify-start')} onClick={onClick} aria-label={label} aria-expanded={!collapsed}>
      <Icon />
      {!collapsed ? label : null}
    </Button>
  )
  if (!collapsed) return action
  return <Tooltip><TooltipTrigger asChild>{action}</TooltipTrigger><TooltipContent side="right" sideOffset={6}>{label}</TooltipContent></Tooltip>
}

function AdminWorkspaceLink({ collapsed }: { collapsed: boolean }) {
  const link = (
    <Button variant="ghost" className={cn('w-full', collapsed ? 'h-10 justify-center px-0' : 'justify-start')} asChild>
      <Link to="/" aria-label={collapsed ? 'Back to workspace' : undefined}>
        <ArrowLeftIcon />
        {!collapsed ? 'Back to workspace' : null}
      </Link>
    </Button>
  )
  if (!collapsed) return link
  return <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right" sideOffset={6}>Back to workspace</TooltipContent></Tooltip>
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
