import { useEffect, useState } from 'react'
import { ChevronDownIcon, PlusIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { NewWorkspaceDialog } from '@/features/workspace/components/new-workspace-dialog'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'
import type { WorkspaceRow } from '@/shared/lib/types'

/**
 * Which body of work the console is showing. Everything under it — agents,
 * documents, databases, files — belongs to the selection.
 *
 * It sits at the head of the sidebar rather than inside settings because it is
 * the frame everything below it is drawn inside, not a preference.
 */
export function WorkspacePicker() {
  const { workspaces, current, loading, setCurrent, create } = useWorkspace()
  const [adding, setAdding] = useState(false)

  const open = workspaces.find((w) => w.id === current) ?? null

  // The first nine are reachable by keystroke, which is what the menu's
  // shortcut column is advertising. Bound here rather than in the shell so the
  // list it indexes and the labels it prints are the same array.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.altKey || event.shiftKey) return
      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index > 8) return
      const target = workspaces[index]
      if (!target) return
      event.preventDefault()
      setCurrent(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaces, setCurrent])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={loading}
          aria-label={open ? `Workspace: ${open.name}` : 'Workspace'}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
            'transition-colors hover:bg-accent',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          )}
        >
          <Monogram name={open?.name ?? '—'} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {open?.name ?? (loading ? 'Loading…' : 'No workspace')}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent side="bottom" align="start" className="min-w-60">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {workspaces.map((workspace, i) => (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              active={workspace.id === current}
              index={i}
              onSelect={() => setCurrent(workspace.id)}
            />
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAdding(true)}>
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground"
            >
              <PlusIcon className="size-3.5" />
            </span>
            Add workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NewWorkspaceDialog
        open={adding}
        onOpenChange={setAdding}
        existing={workspaces}
        onCreate={create}
      />
    </>
  )
}

function WorkspaceItem({
  workspace,
  active,
  index,
  onSelect,
}: {
  workspace: WorkspaceRow
  active: boolean
  index: number
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={cn(active && 'bg-accent/60')}>
      <Monogram name={workspace.name} />
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      {index < 9 ? <DropdownMenuShortcut>{modKey()}{index + 1}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/**
 * The workspace's initials on the brand ramp — the one place colour appears in
 * the console, and what tells two workspaces apart in the menu at a glance.
 */
function Monogram({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-brand-from to-brand-to text-[0.625rem] font-semibold uppercase text-white"
    >
      {initials(name)}
    </span>
  )
}

/** `Acme Corp` → `AC`, `Default` → `DE`. Two letters, always. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return (words[0][0] + words[1][0]).slice(0, 2)
  return (words[0] ?? '—').slice(0, 2)
}

function modKey(): string {
  return navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl '
}
