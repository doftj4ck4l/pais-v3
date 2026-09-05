import { DocumentPanel } from '@/features/resources/components/document-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function DocsPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('docs')}
      description={t('docsPageDescription')}
    >
      <DocumentPanel />
    </ResourcePage>
  )
}
