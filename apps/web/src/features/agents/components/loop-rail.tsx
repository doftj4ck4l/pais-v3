import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * The loop rail: a hairline running the length of the transcript with one node
 * per event the agent produced. Everything the run does lands on this line.
 */
export function RailRow({
  glyph,
  marker,
  dashed = false,
  stub = false,
  className,
  children,
}: {
  /** Node drawn on the rail for this event. */
  glyph?: ReactNode
  /** Small readout to the left of the rail — iteration numbers. */
  marker?: string
  /** Dashed segment: the agent is thinking, not acting. */
  dashed?: boolean
  /** Draw the line only to the node, not past it — used for the last row. */
  stub?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[3.25rem_minmax(0,1fr)] sm:gap-x-5">
      <div className="relative" aria-hidden>
        <span
          className={cn(
            'absolute right-0 top-0 border-r border-rail',
            dashed && 'border-dashed',
            stub ? 'h-4' : 'bottom-0',
          )}
        />
        {marker ? (
          <span className="readout absolute right-3 top-4 -translate-y-1/2 text-[0.625rem] font-medium text-muted-foreground sm:right-3.5">
            {marker}
          </span>
        ) : null}
        {glyph ? (
          <span className="absolute right-0 top-4 flex -translate-y-1/2 translate-x-1/2 items-center justify-center bg-background">
            {glyph}
          </span>
        ) : null}
      </div>
      <div className={cn('min-w-0 pb-6', className)}>{children}</div>
    </div>
  )
}

/** A turn you or the agent committed to. Filled = settled. */
export function NodeSquare({ filled = false }: { filled?: boolean }) {
  return (
    <span
      className={cn(
        'size-2 border border-rail-strong transition-colors duration-300',
        filled ? 'bg-rail-strong' : 'bg-background',
      )}
    />
  )
}

/** The agent speaking. */
export function NodeRing() {
  return <span className="size-2 rounded-full border border-rail-strong bg-background" />
}

/** A section break between loop iterations. */
export function NodeTick() {
  return <span className="h-px w-2.5 bg-rail-strong" />
}

/** The live head of the rail while the loop is still turning. */
export function NodeHead() {
  return <span className="rail-head size-2.5 rounded-full bg-rail-strong" />
}
