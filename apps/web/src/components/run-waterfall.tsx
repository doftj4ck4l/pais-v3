import type { RunSpan } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * A run's spans as a waterfall.
 *
 * Bars are positioned as percentages of the run's total duration, so the chart
 * scales with its container and needs no measurement pass. Each span already
 * arrives with `offsetMs` relative to the run's start — the API does that
 * arithmetic once rather than every client repeating it.
 */

/**
 * `run.start` and `run.end` bracket the run rather than happening inside it.
 * Drawn as bars they would be a zero-width tick and a bar spanning everything,
 * which says nothing the header does not already say.
 */
const BRACKETS = new Set(['run.start', 'run.end'])

/** What each kind of span is called and coloured. Anything else falls through. */
const KINDS: { match: (step: string) => boolean; label: string; bar: string; text: string }[] = [
  {
    match: (s) => s === 'llm.turn',
    label: 'model',
    bar: 'bg-violet-500',
    text: 'text-violet-600 dark:text-violet-400',
  },
  {
    match: (s) => s === 'tool',
    label: 'tool',
    bar: 'bg-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
  },
  {
    match: (s) => s.startsWith('mcp'),
    label: 'mcp',
    bar: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  {
    match: (s) => s.startsWith('sandbox'),
    label: 'sandbox',
    bar: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    match: (s) => s.startsWith('context'),
    label: 'context',
    bar: 'bg-muted-foreground',
    text: 'text-muted-foreground',
  },
]

const FALLBACK = {
  label: 'other',
  bar: 'bg-muted-foreground',
  text: 'text-muted-foreground',
}

function kindOf(step: string) {
  return KINDS.find((k) => k.match(step)) ?? FALLBACK
}

/** The tool's own name when there is one; the step is a poor label for `tool`. */
function labelOf(span: RunSpan): string {
  const name = span.fields.name
  return typeof name === 'string' && name ? name : span.step
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

export function RunWaterfall({
  spans,
  totalMs,
  selectedId,
  onSelect,
}: {
  spans: RunSpan[]
  totalMs: number
  selectedId?: string | null
  onSelect?: (span: RunSpan) => void
}) {
  const bars = spans.filter((s) => !BRACKETS.has(s.step))
  if (!bars.length) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        No spans were recorded for this run. Runs from before the timeline existed have none.
      </p>
    )
  }

  // Guard the divisor: a run that started and ended inside the same millisecond
  // would otherwise put every bar at NaN%.
  const span = Math.max(1, totalMs)

  return (
    <div className="flex flex-col">
      <ol className="flex flex-col">
        {bars.map((s) => {
          const kind = kindOf(s.step)
          const left = Math.min(100, (s.offsetMs / span) * 100)
          // Zero-duration markers still need to be visible, hence the floor.
          const width = Math.max(0.6, Math.min(100 - left, (s.durationMs / span) * 100))
          const instant = s.durationMs === 0

          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect?.(s)}
                aria-pressed={selectedId === s.id}
                className={cn(
                  'grid w-full grid-cols-[13rem_1fr_4.5rem] items-center gap-2 px-3 py-1 text-left',
                  'transition-colors hover:bg-accent/50',
                  selectedId === s.id && 'bg-accent',
                )}
              >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn('size-1.5 shrink-0 rounded-full', kind.bar)} />
                <span className="truncate text-[0.6875rem]" title={labelOf(s)}>
                  {labelOf(s)}
                </span>
              </span>

              <span className="relative h-3.5">
                <span
                  className={cn(
                    'absolute inset-y-0 rounded-sm',
                    kind.bar,
                    instant && 'opacity-50',
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>

              <span
                className={cn(
                  'readout text-right text-[0.625rem] tabular-nums',
                  s.fields.ok === false ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {instant ? '·' : ms(s.durationMs)}
              </span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap gap-3 border-t px-3 py-2">
        {KINDS.map((k) => (
          <span key={k.label} className="flex items-center gap-1.5 text-[0.625rem]">
            <span className={cn('size-1.5 rounded-full', k.bar)} />
            <span className={k.text}>{k.label}</span>
          </span>
        ))}
        <span className="readout ml-auto text-[0.625rem] text-muted-foreground">
          total {ms(totalMs)}
        </span>
      </div>
    </div>
  )
}

/**
 * Which execution context a span's work actually happened in.
 *
 * Worth naming on screen because it is the single most misread thing about the
 * system: an MCP tool call looks like the sandbox tools next to it on the
 * timeline, but it runs in the API process — the sandbox is never involved.
 */
function contextOf(span: RunSpan): string | null {
  const name = typeof span.fields.name === 'string' ? span.fields.name : ''
  if (span.step === 'sandbox.acquire') return 'sandbox container'
  if (span.step === 'mcp.server') {
    const t = span.fields.transport
    return t === 'stdio' ? 'API process → child process' : 'API process → remote HTTP'
  }
  if (span.step === 'tool') {
    if (name.includes('__')) return 'API process → MCP server'
    if (['bash', 'read', 'write', 'edit', 'call_skill'].includes(name)) return 'sandbox container'
    return 'API process'
  }
  if (span.step === 'llm.turn') return 'model provider'
  if (span.step.startsWith('mcp')) return 'API process'
  return null
}

/** Fields already shown in the header, so repeating them in the table is noise. */
const HEADER_FIELDS = new Set(['name', 'ms', 'ok'])

/**
 * Fields that are payloads rather than facts.
 *
 * A tool's arguments and its output are the two things you actually came to
 * read, and both are too long for a definition-list row. They get their own
 * scrollable blocks, in call order: input first, then output.
 */
const PAYLOAD_FIELDS: { key: string; label: string }[] = [
  { key: 'args', label: 'input' },
  { key: 'result', label: 'output' },
  { key: 'answer', label: 'answer' },
  { key: 'error', label: 'error' },
]

function Payload({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="px-3 pb-2">
      <p className="mb-1 text-[0.625rem] text-muted-foreground">{label}</p>
      <pre
        className={cn(
          'readout max-h-56 overflow-auto rounded-md border bg-background px-2 py-1.5',
          'text-[0.625rem] leading-relaxed whitespace-pre-wrap break-all',
          danger && 'text-destructive',
        )}
      >
        {value}
      </pre>
    </div>
  )
}

/** One span, in full. */
export function SpanDetail({ span, onClose }: { span: RunSpan; onClose: () => void }) {
  const kind = kindOf(span.step)
  const where = contextOf(span)
  const payloadKeys = new Set(PAYLOAD_FIELDS.map((p) => p.key))
  const rest = Object.entries(span.fields).filter(
    ([k, v]) => !HEADER_FIELDS.has(k) && !payloadKeys.has(k) && v !== '' && v != null,
  )
  const payloads = PAYLOAD_FIELDS.filter(
    (p) => typeof span.fields[p.key] === 'string' && span.fields[p.key] !== '',
  )

  return (
    <div className="border-t bg-sidebar/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn('size-1.5 shrink-0 rounded-full', kind.bar)} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{labelOf(span)}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-[0.625rem] text-muted-foreground hover:text-foreground"
        >
          close
        </button>
      </div>

      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 px-3 pb-3 text-[0.6875rem]">
        <Row label="step" value={span.step} />
        <Row label="duration" value={span.durationMs ? ms(span.durationMs) : 'instant'} />
        <Row label="offset" value={`+${ms(span.offsetMs)} into the run`} />
        {where ? <Row label="runs in" value={where} /> : null}
        {span.fields.ok === false ? <Row label="outcome" value="failed" danger /> : null}
        {rest.map(([key, value]) => (
          <Row
            key={key}
            label={key}
            value={typeof value === 'string' ? value : JSON.stringify(value)}
          />
        ))}
      </dl>

      {payloads.map((p) => (
        <Payload
          key={p.key}
          label={p.label}
          value={String(span.fields[p.key])}
          danger={p.key === 'error'}
        />
      ))}
    </div>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'readout min-w-0 break-all whitespace-pre-wrap',
          danger && 'text-destructive',
        )}
      >
        {value}
      </dd>
    </>
  )
}

/**
 * Where a run's time actually went, by kind.
 *
 * Spans overlap — tools run in parallel inside a turn — so these sum to more
 * than the wall clock. That is the point: it answers "what is expensive",
 * which is a different question from "how long did it take".
 */
export function RunBreakdown({ spans, totalMs }: { spans: RunSpan[]; totalMs: number }) {
  const totals = new Map<string, number>()
  for (const s of spans) {
    if (BRACKETS.has(s.step) || s.durationMs === 0) continue
    const kind = kindOf(s.step)
    totals.set(kind.label, (totals.get(kind.label) ?? 0) + s.durationMs)
  }

  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1])
  if (!rows.length) return null

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2">
      {rows.map(([label, total]) => {
        const kind = KINDS.find((k) => k.label === label) ?? FALLBACK
        return (
          <span key={label} className="readout text-[0.625rem]">
            <span className={kind.text}>{label}</span>{' '}
            <span className="tabular-nums text-muted-foreground">
              {ms(total)} · {Math.round((total / Math.max(1, totalMs)) * 100)}%
            </span>
          </span>
        )
      })}
    </div>
  )
}
