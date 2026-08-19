import { AgentBuilder } from '@/features/agents-builder/components/agent-builder'
import { ResourcePage } from '@/pages/resources/resource-page'

export function AgentsPage() {
  return (
    <ResourcePage
      title="Agent builder"
      description="Shape a text agent, try it here, then call it from Telegram or any service."
    >
      <AgentBuilder />
    </ResourcePage>
  )
}
