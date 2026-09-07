import { ActivityIcon, Building2Icon, LayoutDashboardIcon, UsersIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type AdminNavItem = {
  to: '/admin' | '/admin/users' | '/admin/organizations' | '/admin/runs'
  label: string
  icon: LucideIcon
}

export type AdminDestination = AdminNavItem & {
  to: '/admin/users' | '/admin/organizations' | '/admin/runs'
  description: string
  action: string
}

export const ADMIN_DESTINATIONS: AdminDestination[] = [
  {
    to: '/admin/users',
    label: 'Users',
    icon: UsersIcon,
    description: 'Track every account, including independent users, with workspace, conversation, run, and token totals.',
    action: 'View user activity',
  },
  {
    to: '/admin/organizations',
    label: 'Departments',
    icon: Building2Icon,
    description: 'Create departments, invite people, assign admins, and grant each department the databases it may query. Workspaces remain private.',
    action: 'Manage departments',
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
