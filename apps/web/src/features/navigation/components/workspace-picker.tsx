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
 * Which body of work the console is showing. Everything the rail leads to —
 * agents, documents, databases, files — belongs to the selection.
 *
 * It sits at the head of the rail rather than inside settings because it is the
 * frame the rest of the console is drawn inside, not a preference. The mark is
 * the workspace's own initials: on a rail this narrow a name would truncate to
 * nothing, and two workspaces truncated to nothing look identical.
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
            'group relative flex size-9 items-center justify-center rounded-lg',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          )}
        >
          <Monogram name={open?.name ?? '—'} />
          {/* Small enough to read as a hint rather than a control: the whole
              square is the button. */}
          <ChevronDownIcon className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-sidebar p-px text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent side="right" align="start">
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
      <Monogram name={workspace.name} size="sm" />
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      {index < 9 ? <DropdownMenuShortcut>{modKey()}{index + 1}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/**
 * The workspace's initials on the brand ramp — the one place colour appears in
 * the console, and the only thing distinguishing two workspaces at rail width.
 */
function Monogram({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md font-semibold uppercase',
        'bg-gradient-to-br from-brand-from to-brand-to text-white',
        size === 'sm' ? 'size-6 text-[0.625rem]' : 'size-8 text-xs',
      )}
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
