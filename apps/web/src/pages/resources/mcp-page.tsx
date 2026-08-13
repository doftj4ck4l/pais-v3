import { McpPanel } from '@/features/resources/components/mcp-panel'
import { ResourcePage } from '@/pages/resources/resource-page'

export function McpPage() {
  return (
    <ResourcePage
      title="MCP"
      description="Servers whose tools the agent can call. Their tools are loaded on demand, not all at once."
    >
      <McpPanel />
    </ResourcePage>
  )
}
