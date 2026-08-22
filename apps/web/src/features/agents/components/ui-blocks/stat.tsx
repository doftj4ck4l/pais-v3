import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import type { StatProps } from '@/features/agents/lib/ui-blocks'

/**
 * A single KPI tile. The delta's colour follows an explicit `trend` when given,
 * and otherwise the sign of the delta — a leading "-" reads as down. `flat`
 * exists so a deliberately neutral change is not coloured as either.
 */
export function Stat({ label, value, delta, trend, help }: StatProps) {
  const dir = trend ?? inferTrend(delta)
  const Icon = dir === 'up' ? ArrowUpRightIcon : dir === 'down' ? ArrowDownRightIcon : ArrowRightIcon

  return (
    <div className="my-4 inline-flex min-w-[10rem] flex-col rounded-lg border bg-card px-4 py-3 text-card-foreground">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      {delta !== undefined ? (
        <span
          className={cn(
            'mt-1 inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
            dir === 'up' && 'text-emerald-600 dark:text-emerald-400',
            dir === 'down' && 'text-red-600 dark:text-red-400',
            dir === 'flat' && 'text-muted-foreground',
          )}
        >
          <Icon className="size-3" />
          {delta}
        </span>
      ) : null}
      {help ? <span className="mt-1 text-xs text-muted-foreground">{help}</span> : null}
    </div>
  )
}

function inferTrend(delta: StatProps['delta']): 'up' | 'down' | 'flat' {
  if (delta === undefined) return 'flat'
  const n = typeof delta === 'number' ? delta : Number(String(delta).replace(/[^0-9.-]/g, ''))
  if (Number.isNaN(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}
