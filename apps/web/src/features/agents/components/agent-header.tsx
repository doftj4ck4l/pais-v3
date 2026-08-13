import { PaperclipIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ModelLogo } from '@/shared/components/model-logo'
import { ContextRing } from '@/features/agents/components/context-ring'
import type { AgentRun } from '@/features/agents/hooks/use-agent-board'
import { STATUS_LABEL, statusEmphasis } from '@/features/agents/lib/status'
import { cn } from '@/shared/lib/utils'
import type { Model } from '@/shared/lib/types'

/**
 * Names the agent you are looking at. Sits outside the scroll area so it stays
 * put while the transcript streams.
 */
export function AgentHeader({
  agent,
  model,
  onStop,
  artifactCount = 0,
  onToggleArtifacts,
}: {
  agent: AgentRun
  model?: Model
  onStop: () => void
  /** How many files and images this chat has produced. Zero hides the control. */
  artifactCount?: number
  onToggleArtifacts?: () => void
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

      <ContextRing context={agent.context} />

      {/* Only once there is something to open. A control that opens an empty
          panel is a control that teaches you not to press it. */}
      {artifactCount > 0 && onToggleArtifacts ? (
        <Button variant="outline" size="sm" onClick={onToggleArtifacts}>
          <PaperclipIcon data-icon="inline-start" />
          {artifactCount}
        </Button>
      ) : null}

      {running ? (
        <Button variant="outline" size="sm" onClick={onStop}>
          <SquareIcon data-icon="inline-start" className="fill-current" />
          Stop
        </Button>
      ) : null}
    </header>
  )
}
