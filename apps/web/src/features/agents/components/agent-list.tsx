import { useState } from 'react'
import { AlertCircleIcon, XIcon } from 'lucide-react'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { ModelLogo } from '@/shared/components/model-logo'
import { STATUS_LABEL, statusEmphasis } from '@/features/agents/lib/status'
import { groupByDay } from '@/features/agents/lib/day-groups'
import { cn } from '@/shared/lib/utils'
import type { AgentRun, AgentStatus } from '@/features/agents/hooks/use-agent-board'
import type { Meta } from '@/shared/lib/types'

export function AgentList({
  meta,
  agents,
  selectedId,
  onSelect,
  onRemove,
}: {
  meta: Meta | null
  agents: AgentRun[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}) {
  // Which agent the X was pressed on. Deleting a conversation removes it from
  // the server too, so there is nothing to undo it with.
  const [pending, setPending] = useState<AgentRun | null>(null)

  if (agents.length === 0) {
    return (
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        No agents yet. Ask something below and one starts here.
      </p>
    )
  }

  // Grouped by day rather than rendered flat, so a sidebar holding a fortnight
  // of work says when each agent was, not just what order it is in.
  const days = groupByDay(agents, (agent) => agent.startedAt)

  return (
    <>
      <div className="flex flex-col gap-3">
        {days.map((day) => (
          <div key={day.key}>
            {/* Sticky: the point of the label is knowing which day you are
                looking at, which is exactly what scrolling takes away. */}
            <h3 className="label sticky top-0 z-10 -mx-1 bg-sidebar px-1 pb-1.5 text-muted-foreground">
              {day.label}
            </h3>
            <ul className="flex flex-col gap-1">
              {day.items.map((agent) => {
                const model = meta?.models.find((m) => m.id === agent.modelId)
                const active = agent.id === selectedId
                const showTime = agent.status !== 'error' && agent.elapsed > 0

                return (
                  // The remove control is a sibling of the select button, never
                  // a child: a button inside a button is invalid HTML.
                  <li key={agent.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelect(agent.id)}
                      aria-current={active}
                      title={new Date(agent.startedAt).toLocaleString()}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 pr-7 text-left transition-colors',
                        active
                          ? 'border-foreground/25 bg-accent'
                          : 'border-transparent hover:bg-accent/60',
                      )}
                    >
                      <StatusGlyph status={agent.status} />

                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[0.8125rem] leading-snug font-semibold">
                          {agent.task || 'Untitled'}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                          <span className={cn('shrink-0', statusEmphasis(agent.status))}>
                            {STATUS_LABEL[agent.status]}
                          </span>
                          {showTime ? (
                            <span className="readout shrink-0 text-[0.625rem]">
                              {(agent.elapsed / 1000).toFixed(1)}s
                            </span>
                          ) : null}
                          <span aria-hidden>·</span>
                          <ModelLogo model={model} size={13} className="rounded-[3px]" />
                          <span className="truncate">{model?.label ?? agent.modelId}</span>
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPending(agent)}
                      aria-label={`Remove agent: ${agent.task || 'Untitled'}`}
                      className="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none group-hover:opacity-100"
                    >
                      <XIcon className="size-3.5" />
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
        title="Delete this agent?"
        description={
          pending?.status === 'running'
            ? `"${pending.task || 'Untitled'}" is still running. Deleting it stops the run and removes its transcript for good.`
            : `"${pending?.task || 'Untitled'}" and its whole transcript will be removed. This cannot be undone.`
        }
        onConfirm={() => pending && onRemove(pending.id)}
      />
    </>
  )
}

/** Status in the monochrome palette — shape and motion, never hue. */
function StatusGlyph({ status }: { status: AgentStatus }) {
  if (status === 'error') {
    return (
      <AlertCircleIcon
        className="mt-0.5 size-3.5 shrink-0 text-foreground"
        aria-label={STATUS_LABEL.error}
      />
    )
  }

  return (
    <span
      aria-label={STATUS_LABEL[status]}
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full border border-foreground',
        status === 'running' && 'rail-head bg-foreground',
        status === 'done' && 'bg-transparent',
        // Stopped: half-filled, so it reads as "ended early" at a glance.
        status === 'stopped' && 'border-dashed bg-transparent',
      )}
    />
  )
}
