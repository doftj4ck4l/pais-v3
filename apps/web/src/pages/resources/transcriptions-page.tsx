import { TranscriptionsPanel } from '@/features/resources/components/transcriptions-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function TranscriptionsPage() {
  const { t } = usePreferences()
  return (
    <ResourcePage
      title={t('transcribeAudio')}
      description={t('transcriptionsPageDescription')}
      fullBleed
    >
      <TranscriptionsPanel />
    </ResourcePage>
  )
}
