import { createFileRoute } from '@tanstack/react-router'
import { AdminRunsPage } from '@/pages/admin/admin-runs-page'

export const Route = createFileRoute('/admin/runs')({
  validateSearch: (search: Record<string, unknown>): { run?: string; user?: string; status?: string; q?: string } => ({
    run: typeof search.run === 'string' ? search.run : undefined,
    user: typeof search.user === 'string' ? search.user : undefined,
    status: typeof search.status === 'string' ? search.status : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: AdminRunsPage,
})
