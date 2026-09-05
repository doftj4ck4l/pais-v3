import { PlaybookPanel } from '@/features/resources/components/playbook-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function LearnedPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('learned')}
      description={t('learnedPageDescription')}
    >
      <PlaybookPanel />
    </ResourcePage>
  )
}
