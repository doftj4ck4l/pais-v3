import { PlaybookPanel } from '@/features/resources/components/playbook-panel'
import { ResourcePage } from '@/pages/resources/resource-page'

export function LearnedPage() {
  return (
    <ResourcePage
      title="Learned"
      description="What this workspace has worked out about its own work, written after each run rather than by anyone typing."
    >
      <PlaybookPanel />
    </ResourcePage>
  )
}
