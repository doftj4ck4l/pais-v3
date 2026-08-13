import { DatabasePanel } from '@/features/resources/components/database-panel'
import { ResourcePage } from '@/pages/resources/resource-page'

export function DataPage() {
  return (
    <ResourcePage
      title="Data"
      description="Databases the agent can query. Credentials are stored encrypted and never returned."
    >
      <DatabasePanel />
    </ResourcePage>
  )
}
