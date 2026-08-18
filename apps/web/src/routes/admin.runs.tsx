import { createFileRoute } from '@tanstack/react-router'
import { AdminRunsPage } from '@/pages/admin/admin-runs-page'

export const Route = createFileRoute('/admin/runs')({
  validateSearch: (search: Record<string, unknown>): { run?: string } => ({
    run: typeof search.run === 'string' ? search.run : undefined,
  }),
  component: AdminRunsPage,
})
