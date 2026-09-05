import { DatabasePanel } from '@/features/resources/components/database-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function DataPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('data')}
      description={t('dataPageDescription')}
    >
      <DatabasePanel />
    </ResourcePage>
  )
}
