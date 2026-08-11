import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import type { ContextUsage } from '@/features/agents/hooks/use-agent-board'
import { cn } from '@/shared/lib/utils'

const SIZE = 18
const STROKE = 2.5
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/**
 * How full this thread's context is, as a ring.
 *
 * A thread grows silently until it stops working, so the cost of a turn is
 * worth showing continuously rather than only at the point of failure. The ring
 * warms through amber and red as the window fills, and the tooltip carries the
 * real numbers.
 */
export function ContextRing({ context }: { context: ContextUsage | null }) {
  if (!context || context.window <= 0) return null

  const ratio = Math.min(1, context.used / context.window)
  const pct = Math.round(ratio * 100)
  const tone =
    ratio >= 0.9
      ? 'text-destructive'
      : ratio >= 0.7
        ? 'text-amber-500'
        : 'text-muted-foreground'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('flex items-center gap-1.5', tone)}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-border"
            />
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              stroke="currentColor"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
              className="transition-[stroke-dashoffset] duration-500"
            />
          </svg>
          <span className="readout text-[0.6875rem] tabular-nums">{pct}%</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <p>
          {fmt(context.used)} / {fmt(context.window)} tokens
          {context.estimated ? ' (estimated)' : ''}
        </p>
        {context.compacted ? (
          <p className="mt-1 text-muted-foreground">
            Compacted {context.compacted.turnsSummarised} earlier message(s):{' '}
            {fmt(context.compacted.fromTokens)} → {fmt(context.compacted.toTokens)} tokens.
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
