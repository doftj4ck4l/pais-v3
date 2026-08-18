import { createFileRoute } from '@tanstack/react-router'
import { AdminRunsPage } from '@/pages/admin/admin-runs-page'
import type { RunStatus } from '@/shared/lib/types'

const RUN_STATUSES = new Set<RunStatus>(['running', 'done', 'error', 'stopped'])

function runStatus(value: unknown): RunStatus | undefined {
  return typeof value === 'string' && RUN_STATUSES.has(value as RunStatus) ? value as RunStatus : undefined
}

export const Route = createFileRoute('/admin/runs')({
  validateSearch: (search: Record<string, unknown>): { run?: string; user?: string; status?: RunStatus; q?: string } => ({
    run: typeof search.run === 'string' ? search.run : undefined,
    user: typeof search.user === 'string' ? search.user : undefined,
    status: runStatus(search.status),
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: AdminRunsPage,
})
