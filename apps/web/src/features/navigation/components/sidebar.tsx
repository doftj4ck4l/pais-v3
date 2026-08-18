import { Link, useNavigate } from '@tanstack/react-router'
import { MessageSquareIcon, PanelLeftIcon, PlusIcon, SettingsIcon, ShieldCheckIcon } from 'lucide-react'
import { AgentList } from '@/features/agents/components/agent-list'
import { BrandMark } from '@/shared/components/brand'
import { NAV_ITEMS } from '@/features/navigation/lib/nav-items'
import { RunStats } from '@/features/agents/components/run-stats'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { UserMenu } from '@/features/navigation/components/user-menu'
import { WorkspacePicker } from '@/features/navigation/components/workspace-picker'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useCloseAside } from '@/features/navigation/lib/aside-context'
import { useOnChats } from '@/features/navigation/lib/rail'
import { cn } from '@/shared/lib/utils'
import { useMe } from '@/features/workspace/hooks/use-me'

/**
 * Two columns: where you can go, and what is in the place you are.
 *
 * The rail is icons only because the labels were the crowding — six words down
 * the left of every page, above a list of runs that is what the sidebar is
 * mostly for. Each icon says its name on hover, so nothing is hidden, it is
 * just not all shouted at once.
 *
 * The second column belongs to Chats and only to Chats: it lists every session,
 * newest first, and choosing one opens it. Going anywhere else closes it,
 * which is why nothing here holds "is the panel open" — the route decides. An
 * explicit open/closed state is what made the earlier version of this hard to
 * reason about: two things could disagree about whether you were in Chats.
 */
export function Sidebar({
  onOpenSettings,
  onCollapse,
}: {
  onOpenSettings: () => void
  /** Hides the second column. Null on narrow screens, where the sheet closes itself. */
  onCollapse: (() => void) | null
}) {
  const board = useBoard()
  const closeAside = useCloseAside()
  const navigate = useNavigate()
  const me = useMe()

  /**
   * Opening a run is also a navigation: the sessions list is reachable from
   * every page, so choosing one from Docs has to land on the transcript rather
   * than silently changing what a page you cannot see is showing.
   */
  const openAgent = (id: string | null) => {
    board.select(id)
    void navigate({ to: '/' })
    closeAside()
  }

  const onChat = useOnChats()

  return (
    <div className="flex h-full bg-sidebar text-sidebar-foreground">
      <nav
        aria-label="Console"
        className="flex w-14 shrink-0 flex-col items-center gap-1 border-r py-3"
      >
        {/* The mark, not the lockup: at rail width the wordmark is a smear.
            It is here because the top bar that used to carry the lockup is
            hidden on exactly the layout most people sit in — wide, on Chats,
            sidebar open — which left the console with no name on it at all.
            Not a link: Chats is directly below it and would be the second
            control on this rail going to the same place. */}
        <BrandMark className="h-5 shrink-0" />

        <div className="my-1 h-px w-6 bg-border" aria-hidden />

        {/* The workspace is the frame everything else is drawn inside, so it
            sits at the head of the rail rather than in settings. */}
        <WorkspacePicker compact />

        <RailButton
          label="Chats"
          icon={MessageSquareIcon}
          active={onChat}
          onClick={() => openAgent(board.selectedId)}
        />

        {NAV_ITEMS.filter((item) => item.to !== '/').map((item) => (
          <RailLink key={item.to} to={item.to} label={item.label} icon={item.icon} />
        ))}

        {me?.canAdministerOrganizations ? (
          <RailLink
            to="/admin"
            label="Admin panel"
            icon={ShieldCheckIcon}
          />
        ) : null}

        <div className="mt-auto flex flex-col items-center gap-1">
          <RailButton label="Settings" icon={SettingsIcon} onClick={onOpenSettings} />
          <UserMenu />
        </div>
      </nav>

      {/*
        Only on Chats. A second column that is empty on five pages out of six is
        a column that teaches you to stop looking at it.
      */}
      {onChat ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-3 py-3">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Chats</h2>
            <button
              type="button"
              onClick={() => openAgent(null)}
              className={cn(
                'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground',
                'transition-colors hover:bg-accent hover:text-foreground',
                'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              <PlusIcon className="size-3.5" />
              New
            </button>
            {onCollapse ? (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Hide the chat list"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <PanelLeftIcon className="size-4" />
              </button>
            ) : null}
          </div>

          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-4 pb-2">
            <AgentList
              meta={board.meta}
              agents={board.agents}
              selectedId={board.selectedId}
              onSelect={openAgent}
              onRemove={board.remove}
            />
          </div>

          {board.selected ? (
            <div className="border-t px-4 py-3">
              <h2 className="label mb-2 text-muted-foreground">This agent</h2>
              <RunStats agent={board.selected} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A rail destination. The label is the tooltip, so the icon can stand alone. */
function RailLink({
  to,
  label,
  icon: Icon,
}: {
  to: string
  label: string
  icon: typeof MessageSquareIcon
}) {
  const closeAside = useCloseAside()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={to}
          onClick={closeAside}
          aria-label={label}
          className={railClass()}
          activeProps={{ className: 'bg-accent text-foreground' }}
        >
          <Icon className="size-[1.125rem]" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The same control for the things that are not routes: Chats, and settings. */
function RailButton({
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  label: string
  icon: typeof MessageSquareIcon
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(railClass(), active && 'bg-accent text-foreground')}
        >
          <Icon className="size-[1.125rem]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

/** Every rail control is the same square: one icon, one hover state. */
function railClass() {
  return cn(
    'flex size-9 items-center justify-center rounded-lg text-muted-foreground',
    'transition-colors hover:bg-accent hover:text-foreground',
    'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
  )
}
