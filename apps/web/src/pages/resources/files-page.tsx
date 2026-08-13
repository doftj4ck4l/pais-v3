import { FilesPanel } from '@/features/resources/components/files-panel'
import { ResourcePage } from '@/pages/resources/resource-page'
import { useBoard } from '@/features/agents/hooks/use-agent-board'

export function FilesPage() {
  // A run is the only thing that writes to the workspace, so its end is the one
  // moment worth re-listing files — cheaper and more accurate than polling.
  const board = useBoard()

  return (
    <ResourcePage
      title="Assets"
      description="Everything the agent has written in this workspace's sandbox, and the chat it came from."
    >
      <FilesPanel refreshKey={board.runsCompleted} />
    </ResourcePage>
  )
}
