import { createFileRoute } from '@tanstack/react-router'
import { AgentsPage } from '@/pages/agents/agents-page'

export const Route = createFileRoute('/agents')({
  component: AgentsPage,
})
