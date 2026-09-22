import { PaperclipIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ModelLogo } from '@/shared/components/model-logo'
import { ContextRing } from '@/features/agents/components/context-ring'
import type { AgentRun } from '@/features/agents/hooks/use-agent-board'
import { STATUS_KEY, statusEmphasis } from '@/features/agents/lib/status'
import { cn } from '@/shared/lib/utils'
import type { ConversationMode, Model } from '@/shared/lib/types'
import { usePreferences } from '@/shared/hooks/use-preferences'

/**
 * The console's fixed top bar. Conversation identity stays left, the page-level
 * Chat/Work choice owns the centre, and run actions stay right.
 */
export function AgentHeader({
  agent,
  model,
  mode,
  onModeChange,
  onStop,
  artifactCount = 0,
  onToggleArtifacts,
}: {
  agent: AgentRun | null
  model?: Model
  mode: ConversationMode
  onModeChange: (mode: ConversationMode) => void
  onStop?: () => void
  /** How many files and images this chat has produced. Zero hides the control. */
  artifactCount?: number
  onToggleArtifacts?: () => void
}) {
  const running = agent?.status === 'running'
  const { t } = usePreferences()

  return (
    <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 bg-background/90 px-3 backdrop-blur-sm sm:px-5">
      <div className="min-w-0">
        {agent ? (
          <>
            <h1 className="truncate text-sm leading-snug font-medium">{agent.task}</h1>
            <p className="mt-0.5 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              <ModelLogo model={model} size={13} className="rounded-[3px]" />
              <span className="truncate">{model?.label ?? agent.modelId}</span>
              <span aria-hidden>·</span>
              <span className={cn(statusEmphasis(agent.status))}>{t(STATUS_KEY[agent.status])}</span>
            </p>
          </>
        ) : null}
      </div>

      <ConversationModeControl
        mode={mode}
        onChange={onModeChange}
        locked={agent !== null}
      />

      <div className="flex min-w-0 items-center justify-end gap-2">
        {agent ? <ContextRing context={agent.context} /> : null}

        {/* Only once there is something to open. A control that opens an empty
            panel is a control that teaches you not to press it. */}
        {artifactCount > 0 && onToggleArtifacts ? (
          <Button variant="outline" size="sm" onClick={onToggleArtifacts}>
            <PaperclipIcon data-icon="inline-start" />
            {artifactCount}
          </Button>
        ) : null}

        {running && onStop ? (
          <Button variant="outline" size="sm" onClick={onStop}>
            <SquareIcon data-icon="inline-start" className="fill-current" />
            <span className="hidden sm:inline">{t('stop')}</span>
          </Button>
        ) : null}
      </div>
    </header>
  )
}

function ConversationModeControl({
  mode,
  onChange,
  locked,
}: {
  mode: ConversationMode
  onChange: (mode: ConversationMode) => void
  locked: boolean
}) {
  const { t } = usePreferences()
  return (
    <div
      className="flex items-center rounded-xl bg-muted/70 p-1 ring-1 ring-border/60"
      aria-label={t('conversationMode')}
    >
      {([
        ['chat', t('chatMode'), t('chatModeDescription')],
        ['work', t('workMode'), t('workModeDescription')],
      ] as const).map(([value, label, description]) => {
        const active = mode === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            disabled={locked}
            title={locked ? t('differentMode') : description}
            aria-pressed={active}
            className={cn(
              'h-7 min-w-14 rounded-lg px-2 text-xs font-medium transition-[background-color,color,box-shadow] sm:min-w-16 sm:px-3',
              'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              locked && !active && 'opacity-45',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
