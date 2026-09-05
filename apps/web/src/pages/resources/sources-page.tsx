import { ConnectorPanel } from '@/features/resources/components/connector-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function SourcesPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('sources')}
      description={t('sourcesPageDescription')}
    >
      <ConnectorPanel />
    </ResourcePage>
  )
}
