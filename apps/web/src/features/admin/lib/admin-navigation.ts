import { ActivityIcon, Building2Icon, LayoutDashboardIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type AdminNavItem = {
  to: '/admin' | '/admin/organizations' | '/admin/runs'
  label: string
  icon: LucideIcon
}

export type AdminDestination = AdminNavItem & {
  to: '/admin/organizations' | '/admin/runs'
  description: string
  action: string
}

export const ADMIN_DESTINATIONS: AdminDestination[] = [
  {
    to: '/admin/organizations',
    label: 'Organizations',
    icon: Building2Icon,
    description: 'Create organizations, invite people, and manage membership. Workspaces remain private to each person.',
    action: 'Manage organizations',
  },
  {
    to: '/admin/runs',
    label: 'Runs',
    icon: ActivityIcon,
    description: 'Inspect agent runs, timings, tool calls, and failures when you need operational detail.',
    action: 'Inspect runs',
  },
]

export const ADMIN_NAV: AdminNavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboardIcon },
  ...ADMIN_DESTINATIONS,
]
