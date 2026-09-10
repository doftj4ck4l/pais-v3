import { useState } from 'react'
import { AlertCircleIcon, MoreHorizontalIcon } from 'lucide-react'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
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
  onRemove,
}: {
  agents: AgentRun[]
  selectedId: string | null
  onSelect: (id: string) => void
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
  const days = groupByDay(agents, (agent) => agent.startedAt, new Date(), language)

  return (
    <>
      <div className="flex flex-col gap-3">
        {days.map((day) => (
          <div key={day.key}>
            <h3 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
              {day.label}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {day.items.map((agent) => {
                const active = agent.id === selectedId

                return (
                  // The remove control is a sibling of the select button, never
                  // a child: a button inside a button is invalid HTML.
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
                      <span className="min-w-0 flex-1 truncate">{agent.task || t('untitled')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPending(agent)}
                      aria-label={t('removeAgent', { name: agent.task || t('untitled') })}
                      className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none group-hover:opacity-100"
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
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
