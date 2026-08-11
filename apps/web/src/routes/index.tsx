import { createFileRoute } from '@tanstack/react-router'
import { Console } from '@/pages/console/console-page'

// The route is the binding; the page is the page. TanStack requires this
// file to live here and generates routeTree.gen.ts from it.
export const Route = createFileRoute('/')({
  component: Console,
})
