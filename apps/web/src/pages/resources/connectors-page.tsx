import { McpPanel } from '@/features/resources/components/mcp-panel'
import { ResourcePage } from '@/pages/resources/resource-page'

export function ConnectorsPage() {
  return (
    <ResourcePage
      title="Connectors"
      description="Services the agent can use. Their tools are loaded on demand, not all at once."
    >
      <McpPanel />
    </ResourcePage>
  )
}
