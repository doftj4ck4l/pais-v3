import { AgentBuilder } from '@/features/agents-builder/components/agent-builder'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function AgentsPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('agentsPage')}
      description={t('agentsPageDescription')}
    >
      <AgentBuilder />
    </ResourcePage>
  )
}
