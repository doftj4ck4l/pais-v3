import { createFileRoute } from '@tanstack/react-router'
import { DocsPage } from '@/pages/resources/docs-page'

// The route is the binding; the page is the page. TanStack requires this file
// to live here and generates routeTree.gen.ts from it.
export const Route = createFileRoute('/docs')({
  component: DocsPage,
})
