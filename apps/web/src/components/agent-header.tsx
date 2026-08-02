import { SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModelLogo } from '@/components/model-logo'
import type { AgentRun } from '@/hooks/use-agent-board'
import { STATUS_LABEL, statusEmphasis } from '@/lib/status'
import { cn } from '@/lib/utils'
import type { Model } from '@/lib/types'

/**
 * Names the agent you are looking at. Sits outside the scroll area so it stays
 * put while the transcript streams.
 */
export function AgentHeader({
  agent,
  model,
  onStop,
}: {
  agent: AgentRun
  model?: Model
  onStop: () => void
}) {
  const running = agent.status === 'running'

  return (
    <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-6">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[0.9375rem] leading-snug font-bold tracking-[-0.01em]">
          {agent.task}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ModelLogo model={model} size={13} className="rounded-[3px]" />
          <span className="truncate">{model?.label ?? agent.modelId}</span>
          <span aria-hidden>·</span>
          <span className={cn(statusEmphasis(agent.status))}>{STATUS_LABEL[agent.status]}</span>
        </p>
      </div>

      {running ? (
        <Button variant="outline" size="sm" onClick={onStop}>
          <SquareIcon data-icon="inline-start" className="fill-current" />
          Stop
        </Button>
      ) : null}
    </header>
  )
}
