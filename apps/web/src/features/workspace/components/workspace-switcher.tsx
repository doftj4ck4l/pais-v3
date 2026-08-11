import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select'
import { NewWorkspaceDialog } from '@/features/workspace/components/new-workspace-dialog'
import type { WorkspaceRow } from '@/shared/lib/types'

/**
 * Which body of work the console is showing. Everything below it — agents,
 * documents, databases, files — belongs to the selection.
 *
 * It sits directly under the wordmark rather than inside settings because it is
 * the frame the rest of the sidebar is drawn inside, not a preference.
 */
export function WorkspaceSwitcher({
  workspaces,
  current,
  loading,
  onSelect,
  onCreate,
}: {
  workspaces: WorkspaceRow[]
  current: string | null
  loading: boolean
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<unknown>
}) {
  const [adding, setAdding] = useState(false)

  return (
    <div className="flex items-center gap-1.5 border-b px-3 py-2.5">
      <Select value={current ?? undefined} onValueChange={onSelect} disabled={loading}>
        <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label="Workspace">
          <SelectValue placeholder={loading ? 'Loading…' : 'No workspace'} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setAdding(true)}
        aria-label="New workspace"
        className="shrink-0 text-muted-foreground"
      >
        <PlusIcon />
      </Button>

      <NewWorkspaceDialog
        open={adding}
        onOpenChange={setAdding}
        existing={workspaces}
        onCreate={onCreate}
      />
    </div>
  )
}
