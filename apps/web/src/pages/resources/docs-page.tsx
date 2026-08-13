import { DocumentPanel } from '@/features/resources/components/document-panel'
import { ResourcePage } from '@/pages/resources/resource-page'

export function DocsPage() {
  return (
    <ResourcePage
      title="Docs"
      description="Documents this workspace has indexed. The agent searches them with search_docs."
    >
      <DocumentPanel />
    </ResourcePage>
  )
}
