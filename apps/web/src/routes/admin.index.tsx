import { createFileRoute, redirect } from '@tanstack/react-router'
import { AdminDashboard } from '@/pages/admin/admin-dashboard'

export const Route = createFileRoute('/admin/')({
  validateSearch: (search: Record<string, unknown>): { run?: string } => ({
    run: typeof search.run === 'string' ? search.run : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.run) {
      throw redirect({ to: '/admin/runs', search: { run: search.run } })
    }
  },
  component: AdminDashboard,
})
