import { createFileRoute } from '@tanstack/react-router'
import { Admin } from '@/pages/admin/admin-page'

// The route is the binding; the page is the page. TanStack requires this file
// to live here and generates routeTree.gen.ts from it.
//
// The selected run lives in the URL rather than in state, so a slow run is a
// link you can send someone — which is most of the value of having the page at
// all.
export const Route = createFileRoute('/admin')({
  validateSearch: (search: Record<string, unknown>): { run?: string } => ({
    run: typeof search.run === 'string' ? search.run : undefined,
  }),
  component: Admin,
})
