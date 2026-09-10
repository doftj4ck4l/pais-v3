import { Link, useNavigate } from '@tanstack/react-router'
import {
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { AgentList } from '@/features/agents/components/agent-list'
import { Brand } from '@/shared/components/brand'
import { NAV_ITEMS } from '@/features/navigation/lib/nav-items'
import { TranscribeControl } from '@/features/navigation/components/transcribe-control'
import { UserMenu } from '@/features/navigation/components/user-menu'
import { WorkspacePicker } from '@/features/navigation/components/workspace-picker'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useCloseAside } from '@/features/navigation/lib/aside-context'
import { useOnChats } from '@/features/navigation/lib/rail'
import { cn } from '@/shared/lib/utils'
import { useMe } from '@/features/workspace/hooks/use-me'
import { usePreferences } from '@/shared/hooks/use-preferences'

/**
 * The app's single navigation surface.
 *
 * At desktop width this follows the familiar chat-product pattern: one calm,
 * labelled column for starting work, moving around, and reopening history.
 * The same column becomes a sheet on mobile, so labels and ordering never
 * change with the viewport.
 */
export function Sidebar({
  onOpenSettings,
  onCollapse,
}: {
  onOpenSettings: () => void
  /** Hidden in the mobile sheet, whose own close control occupies this spot. */
  onCollapse: (() => void) | null
}) {
  const board = useBoard()
  const closeAside = useCloseAside()
  const navigate = useNavigate()
  const me = useMe()
  const { t } = usePreferences()
  const onChat = useOnChats()

  const openAgent = (id: string | null) => {
    board.select(id)
    void navigate({ to: '/' })
    closeAside()
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-sidebar px-2 py-2 text-sidebar-foreground">
      <div className="sidebar-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex h-10 items-center gap-2 px-2">
          <Brand className="h-[1.125rem] min-w-0" />
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={t('hideChatList')}
              className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/30 focus-visible:outline-none"
            >
              <PanelLeftCloseIcon className="size-[1.125rem]" />
            </button>
          ) : null}
        </div>

        <div className="mt-1">
          <WorkspacePicker />
        </div>

        <nav aria-label={t('console')} className="mt-2 grid gap-0.5">
          <SidebarButton
            label={t('newChat')}
            icon={PlusIcon}
            onClick={() => openAgent(null)}
            emphasized
          />
          <SidebarButton
            label={t('chats')}
            icon={MessageSquareIcon}
            active={onChat}
            onClick={() => openAgent(board.selectedId)}
          />

          {NAV_ITEMS.filter((item) => item.to !== '/').map((item) => (
            <SidebarLink key={item.to} to={item.to} label={t(item.label)} icon={item.icon} />
          ))}

          <TranscribeControl />

          {me?.canAdministerOrganizations ? (
            <SidebarLink to="/admin" label={t('adminPanel')} icon={ShieldCheckIcon} />
          ) : null}
        </nav>

        <section className="mt-4" aria-label={t('chats')}>
          <h2 className="px-2 pb-2 text-xs font-medium text-muted-foreground">{t('chats')}</h2>
          <AgentList
            agents={board.agents}
            selectedId={board.selectedId}
            onSelect={openAgent}
            onRemove={board.remove}
          />
        </section>
      </div>

      <div className="mt-2 grid shrink-0 gap-0.5">
        <SidebarButton label={t('settings')} icon={SettingsIcon} onClick={onOpenSettings} />
        <UserMenu expanded />
      </div>
    </div>
  )
}

function SidebarLink({
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
    <Link
      to={to}
      onClick={closeAside}
      className={sidebarRowClass()}
      activeOptions={{ exact: to === '/' }}
      activeProps={{ className: 'bg-sidebar-accent text-sidebar-accent-foreground' }}
    >
      <Icon className="size-[1.125rem]" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </Link>
  )
}

function SidebarButton({
  label,
  icon: Icon,
  active = false,
  emphasized = false,
  onClick,
}: {
  label: string
  icon: typeof MessageSquareIcon
  active?: boolean
  emphasized?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        sidebarRowClass(),
        active && 'bg-sidebar-accent text-sidebar-accent-foreground',
        emphasized && 'font-medium',
      )}
    >
      <Icon className="size-[1.125rem]" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function sidebarRowClass() {
  return cn(
    'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-sidebar-foreground',
    'transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/30 focus-visible:outline-none',
  )
}
