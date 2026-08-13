import { Link, useNavigate } from '@tanstack/react-router'
import { PanelLeftIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { AgentList } from '@/features/agents/components/agent-list'
import { NAV_ITEMS } from '@/features/navigation/lib/nav-items'
import { RunStats } from '@/features/agents/components/run-stats'
import { UserMenu } from '@/features/navigation/components/user-menu'
import { WorkspacePicker } from '@/features/navigation/components/workspace-picker'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useCloseAside } from '@/features/navigation/lib/aside-context'
import { cn } from '@/shared/lib/utils'
import { Brand } from '@/shared/components/brand'

/**
 * One column, holding everywhere you can go and everything you have run.
 *
 * This replaced an icon rail beside a second column of agents. Two columns of
 * navigation is one too many: the rail said where the pages were, the column
 * beside it said where the agents were, and reaching either meant reading both.
 * Destinations are a short labelled list at the top; the runs are underneath,
 * where they are the thing the sidebar is mostly showing.
 */
export function Sidebar({
  onOpenSettings,
  onCollapse,
}: {
  onOpenSettings: () => void
  /** Hides the sidebar. Null on narrow screens, where the sheet closes itself. */
  onCollapse: (() => void) | null
}) {
  const board = useBoard()
  const closeAside = useCloseAside()
  const navigate = useNavigate()

  /**
   * Opening a run is also a navigation: the agent list is on every page, so
   * choosing one from Docs has to land on the transcript rather than silently
   * changing what a page you cannot see is showing.
   */
  const openAgent = (id: string | null) => {
    board.select(id)
    void navigate({ to: '/' })
    closeAside()
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-3 py-3">
        <Brand className="ml-1 h-5 shrink-0" />
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide the sidebar"
            className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <PanelLeftIcon className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="px-2">
        <WorkspacePicker />
      </div>

      <nav aria-label="Console" className="flex flex-col gap-0.5 px-2 py-2">
        <button type="button" onClick={() => openAgent(null)} className={rowClass()}>
          <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
          New agent
        </button>

        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            // Without this every route matches `/`, so Chat would be lit on
            // every page.
            activeOptions={{ exact: item.to === '/' }}
            onClick={closeAside}
            className={rowClass()}
            activeProps={{ className: 'bg-accent font-medium text-foreground' }}
          >
            <item.icon className="size-4 shrink-0 text-muted-foreground" />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="mt-1 flex min-h-0 flex-1 flex-col px-3">
        <div className="mb-2 flex items-center gap-2 px-1">
          <h2 className="label text-muted-foreground">Recents</h2>
          <span className="readout text-[0.625rem] text-muted-foreground">
            {board.agents.length}
          </span>
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          <AgentList
            meta={board.meta}
            agents={board.agents}
            selectedId={board.selectedId}
            onSelect={openAgent}
            onRemove={board.remove}
          />
        </div>
      </div>

      {board.selected ? (
        <div className="border-t px-4 py-3">
          <h2 className="label mb-2 text-muted-foreground">This agent</h2>
          <RunStats agent={board.selected} />
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <UserMenu />
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          className="ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <SettingsIcon className="size-4" />
        </button>
      </div>
    </div>
  )
}

/** Every row in the sidebar is the same row: icon, label, one hover state. */
function rowClass() {
  return cn(
    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground',
    'transition-colors hover:bg-accent hover:text-foreground',
    'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
  )
}
