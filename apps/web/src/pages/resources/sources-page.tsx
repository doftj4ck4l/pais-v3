import { ConnectorPanel } from '@/features/resources/components/connector-panel'
import { ResourcePage } from '@/pages/resources/resource-page'

export function SourcesPage() {
  return (
    <ResourcePage
      title="Sources"
      description="Places documents come from on their own. A connector's files land in the same index as an upload."
    >
      <ConnectorPanel />
    </ResourcePage>
  )
}
