import { useState } from 'react'
import {
  AlertCircleIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from 'lucide-react'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { STATUS_KEY } from '@/features/agents/lib/status'
import { groupByDay } from '@/features/agents/lib/day-groups'
import { cn } from '@/shared/lib/utils'
import type { AgentRun, AgentStatus } from '@/features/agents/hooks/use-agent-board'
import { localeFor } from '@/shared/lib/i18n'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function AgentList({
  agents,
  selectedId,
  onSelect,
  onPin,
  onRemove,
}: {
  agents: AgentRun[]
  selectedId: string | null
  onSelect: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onRemove: (id: string) => void
}) {
  // Which agent the X was pressed on. Deleting a conversation removes it from
  // the server too, so there is nothing to undo it with.
  const [pending, setPending] = useState<AgentRun | null>(null)
  const { language, t } = usePreferences()

  if (agents.length === 0) {
    return (
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        {t('noAgents')}
      </p>
    )
  }

  // Grouped by day rather than rendered flat, so a sidebar holding a fortnight
  // of work says when each agent was, not just what order it is in.
  const pinned = agents
    .filter((agent) => agent.pinned)
    .sort((a, b) => b.startedAt - a.startedAt)
  const days = groupByDay(
    agents.filter((agent) => !agent.pinned),
    (agent) => agent.startedAt,
    new Date(),
    language,
  )

  return (
    <>
      <div className="flex flex-col gap-3">
        {pinned.length > 0 ? (
          <AgentGroup
            label={t('pinnedChats')}
            agents={pinned}
            selectedId={selectedId}
            onSelect={onSelect}
            onPin={onPin}
            onRemove={setPending}
          />
        ) : null}
        {days.map((day) => (
          <AgentGroup
            key={day.key}
            label={day.label}
            agents={day.items}
            selectedId={selectedId}
            onSelect={onSelect}
            onPin={onPin}
            onRemove={setPending}
          />
        ))}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={t('deleteAgentTitle')}
        description={
          pending?.status === 'running'
            ? t('deleteRunningAgent', { name: pending.task || t('untitled') })
            : t('deleteAgentDescription', { name: pending?.task || t('untitled') })
        }
        onConfirm={() => pending && onRemove(pending.id)}
      />
    </>
  )
}

function AgentGroup({
  label,
  agents,
  selectedId,
  onSelect,
  onPin,
  onRemove,
}: {
  label: string
  agents: AgentRun[]
  selectedId: string | null
  onSelect: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onRemove: (agent: AgentRun) => void
}) {
  const { language, t } = usePreferences()

  return (
    <div>
      <h3 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">{label}</h3>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const active = agent.id === selectedId
          const name = agent.task || t('untitled')

          return (
            // Both controls are siblings: nesting the menu trigger inside the
            // conversation button would create invalid, keyboard-hostile HTML.
            <li key={agent.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(agent.id)}
                aria-current={active}
                title={new Date(agent.startedAt).toLocaleString(localeFor(language))}
                className={cn(
                  'flex h-9 w-full items-center gap-2 rounded-lg px-2 pr-8 text-left text-sm transition-colors',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'hover:bg-sidebar-accent',
                )}
              >
                <StatusGlyph status={agent.status} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {agent.pinned ? (
                  <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : null}
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('chatActions', { name })}
                    className={cn(
                      'absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none group-hover:opacity-100 data-[state=open]:bg-foreground/10 data-[state=open]:opacity-100',
                      active ? 'opacity-100' : 'opacity-0',
                    )}
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className="min-w-40">
                  <DropdownMenuItem
                    disabled={!agent.conversationId}
                    onSelect={() => onPin(agent.id, !agent.pinned)}
                  >
                    {agent.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
                    {t(agent.pinned ? 'unpinChat' : 'pinChat')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onRemove(agent)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2Icon className="size-4" />
                    {t('remove')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** A small state cue that does not compete with the conversation title. */
function StatusGlyph({ status }: { status: AgentStatus }) {
  const { t } = usePreferences()
  if (status === 'error') {
    return (
      <AlertCircleIcon
        className="size-3.5 shrink-0 text-destructive"
        aria-label={t(STATUS_KEY.error)}
      />
    )
  }

  return (
    <span
      aria-label={t(STATUS_KEY[status])}
      className={cn(
        'size-1.5 shrink-0 rounded-full border border-muted-foreground/70',
        status === 'running' && 'rail-head border-foreground bg-foreground',
        status === 'done' && 'bg-transparent opacity-60',
        // Stopped: half-filled, so it reads as "ended early" at a glance.
        status === 'stopped' && 'border-dashed bg-transparent',
      )}
    />
  )
}
