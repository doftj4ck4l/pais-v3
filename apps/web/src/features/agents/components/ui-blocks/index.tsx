import { Suspense, lazy } from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { DataTable } from './data-table'
import { Stat } from './stat'
import { Card } from './card'
import type { Segment, UiSpec } from '@/features/agents/lib/ui-blocks'

// recharts is ~100kb; a chat with no charts should not pay for it. The catalog
// only reaches this file when a validated block exists, but the import still
// splits so the bundle a chartless session downloads stays small.
const Chart = lazy(() => import('./chart').then((m) => ({ default: m.Chart })))

/**
 * Render one message segment. Markdown segments are handled by the transcript
 * itself; this owns the generative-UI ones — a validated block, a block still
 * streaming, or a block the catalog rejected.
 */
export function SegmentView({ segment }: { segment: Exclude<Segment, { kind: 'markdown' }> }) {
  if (segment.kind === 'ui-pending') {
    return (
      <div className="my-4 h-[260px] animate-pulse rounded-lg border bg-muted/30" aria-label="Preparing…" />
    )
  }
  if (segment.kind === 'ui-error') {
    return (
      <div className="my-4 flex items-start gap-2 rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>Could not render a UI block ({segment.reason}).</span>
      </div>
    )
  }
  return <UiComponent spec={segment.spec} />
}

function UiComponent({ spec }: { spec: UiSpec }) {
  switch (spec.component) {
    case 'chart':
      return (
        <Suspense fallback={<div className="my-4 h-[260px] animate-pulse rounded-lg border bg-muted/30" />}>
          <Chart {...spec.props} />
        </Suspense>
      )
    case 'table':
      return <DataTable {...spec.props} />
    case 'stat':
      return <Stat {...spec.props} />
    case 'card':
      return <Card {...spec.props} />
  }
}
