import { createFileRoute } from '@tanstack/react-router'
import { TranscriptionsPage } from '@/pages/resources/transcriptions-page'

// The route is the binding; the page is the page. TanStack requires this file
// to live here and generates routeTree.gen.ts from it.
export const Route = createFileRoute('/transcriptions')({
  component: TranscriptionsPage,
})
