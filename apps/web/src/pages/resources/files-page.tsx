import { FilesPanel } from '@/features/resources/components/files-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function FilesPage() {
  // A run is the only thing that writes to the workspace, so its end is the one
  // moment worth re-listing files — cheaper and more accurate than polling.
  const board = useBoard()
  const { t } = usePreferences()

  return (
    <ResourcePage
      title={t('assets')}
      description={t('assetsPageDescription')}
    >
      <FilesPanel refreshKey={board.runsCompleted} />
    </ResourcePage>
  )
}
