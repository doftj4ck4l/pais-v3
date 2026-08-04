import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { WorkspaceRow } from '@/lib/types'

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
  onCreate: (name: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  if (adding) {
    return (
      <form
        className="flex items-center gap-1.5 border-b px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onCreate(name.trim())
          setName('')
          setAdding(false)
        }}
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          // Blur cancels, so an accidental click outside does not leave a
          // half-typed name sitting in the sidebar.
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          placeholder="Workspace name"
          aria-label="New workspace name"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
        />
      </form>
    )
  }

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
    </div>
  )
}
