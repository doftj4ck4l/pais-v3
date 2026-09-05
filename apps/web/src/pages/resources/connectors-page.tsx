import { McpPanel } from '@/features/resources/components/mcp-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function ConnectorsPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('connectors')}
      description={t('connectorsPageDescription')}
    >
      <McpPanel />
    </ResourcePage>
  )
}
