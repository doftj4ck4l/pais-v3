import { useMemo, useState } from 'react'
import {
  CircleDashedIcon,
  CloudIcon,
  ContainerIcon,
  GaugeIcon,
  PlugIcon,
  WrenchIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RunSpan } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'
import {
  collapseUnchangedToolAvailability,
  descriptionOf,
  fieldLabelOf,
  labelOf,
  payloadPresentationOf,
  SPAN_PAYLOAD_KEYS,
} from './run-span-presentation'

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

/**
 * What each kind of span is called, coloured, and marked with.
 *
 * The icons encode *where the work happened*, which is the single most misread
 * thing about this system and the same question `contextOf` answers in words: a
 * plug for a remote MCP service, a container for the sandbox, a cloud for the
 * model provider. A wrench stays generic because a tool call is the one kind
 * that runs in either place.
 */
type Kind = {
  match: (step: string) => boolean
  label: string
  bar: string
  text: string
  Icon: LucideIcon
}

const KINDS: Kind[] = [
  {
    match: (s) => s === 'llm.turn',
    label: 'model',
    bar: 'bg-violet-500',
    text: 'text-violet-600 dark:text-violet-400',
    Icon: CloudIcon,
  },
  {
    match: (s) => s === 'tool',
    label: 'tool',
    bar: 'bg-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
    Icon: WrenchIcon,
  },
  {
    match: (s) => s.startsWith('mcp'),
    label: 'mcp',
    bar: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    Icon: PlugIcon,
  },
  {
    match: (s) => s.startsWith('sandbox'),
    label: 'sandbox',
    bar: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    Icon: ContainerIcon,
  },
  {
    match: (s) => s.startsWith('context'),
    label: 'context',
    bar: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    Icon: GaugeIcon,
  },
]

const FALLBACK: Kind = {
  match: () => true,
  label: 'other',
  bar: 'bg-muted-foreground',
  text: 'text-muted-foreground',
  Icon: CircleDashedIcon,
}

function kindOf(step: string) {
  return KINDS.find((k) => k.match(step)) ?? FALLBACK
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
  // Which kinds are highlighted. Empty means no filter — everything reads at
  // full strength, rather than an empty selection hiding the whole run.
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const bars = collapseUnchangedToolAvailability(spans.filter((s) => !BRACKETS.has(s.step)))

  // Only kinds this run actually contains get a chip. Offering "sandbox" on a
  // run that never touched one is a control that can only disappoint.
  const present = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of bars) {
      const label = kindOf(s.step).label
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ kind: KINDS.find((k) => k.label === label) ?? FALLBACK, count }))
      .sort((a, b) => b.count - a.count)
  }, [bars])

  // A filter left over from a run that had MCP spans must not dim a run that
  // has none into uniform grey. Only selections that match something count.
  const active = useMemo(() => {
    const here = new Set(present.map((p) => p.kind.label))
    return new Set([...picked].filter((label) => here.has(label)))
  }, [picked, present])

  const toggle = (label: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(label)) next.add(label)
      return next
    })

  if (!bars.length) {
    return (
      <p className="p-5 text-sm text-muted-foreground">
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
          // Dimmed rather than removed: the waterfall's whole point is where
          // work sits in time, and dropping rows would close the gaps that show
          // it. Muted spans stay clickable.
          const muted = active.size > 0 && !active.has(kind.label)

          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect?.(s)}
                aria-pressed={selectedId === s.id}
                className={cn(
                  'grid w-full grid-cols-[minmax(8rem,15rem)_minmax(7rem,1fr)_4.5rem] items-center gap-3 px-5 py-2 text-left',
                  'transition-[background-color,opacity] hover:bg-accent/50',
                  selectedId === s.id && 'bg-accent',
                  muted && 'opacity-30',
                )}
              >
              <span className="flex min-w-0 items-center gap-1.5">
                <kind.Icon className={cn('size-4 shrink-0', kind.text)} aria-hidden />
                <span className="truncate text-sm" title={labelOf(s)}>
                  {labelOf(s)}
                </span>
              </span>

              <span className="relative h-4">
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
                  'readout text-right text-xs tabular-nums',
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

      {/* The legend is the filter. Two rows — one to read, one to click —
          would be the same information twice. */}
      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
        {present.map(({ kind, count }) => {
          const on = active.has(kind.label)
          return (
            <button
              key={kind.label}
              type="button"
              onClick={() => toggle(kind.label)}
              aria-pressed={on}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                'transition-colors hover:bg-accent',
                'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                on ? 'border-transparent bg-accent' : 'border-transparent text-muted-foreground',
              )}
            >
              <kind.Icon className={cn('size-3.5 shrink-0', on ? kind.text : undefined)} aria-hidden />
              <span className={on ? kind.text : undefined}>{kind.label}</span>
              <span className="readout tabular-nums opacity-60">{count}</span>
            </button>
          )
        })}

        {/* Only offered once there is something to clear. */}
        {active.size > 0 ? (
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            show all
          </button>
        ) : null}

        <span className="readout ml-auto text-xs text-muted-foreground">
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
function Payload({ label, meta, value, danger }: { label: string; meta: string; value: string; danger?: boolean }) {
  return (
    <div className="px-4 pb-4">
      <p className="mb-1.5 flex items-baseline gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums opacity-60">{meta}</span>
      </p>
      <pre
        className={cn(
          // Each payload scrolls inside its own box rather than the panel
          // growing without bound: input and output are usually read together,
          // and a 40k-character result would push the other one off screen.
          'readout max-h-72 overflow-auto rounded-md border bg-background px-3 py-2.5',
          'text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
          danger && 'text-destructive',
        )}
      >
        {value}
      </pre>
    </div>
  )
}

/**
 * One span, in full.
 *
 * The inspector docks beneath the waterfall. This preserves the selected
 * run's reading width while keeping a long payload visible during span-to-span
 * comparison.
 */
export function SpanDetail({ span, onClose }: { span: RunSpan; onClose: () => void }) {
  const kind = kindOf(span.step)
  const where = contextOf(span)
  const description = descriptionOf(span)
  const payloadKeys = new Set(SPAN_PAYLOAD_KEYS)
  const rest = Object.entries(span.fields).filter(
    ([k, v]) => !HEADER_FIELDS.has(k) && !payloadKeys.has(k) && v !== '' && v != null,
  )
  const payloads = SPAN_PAYLOAD_KEYS.filter(
    (key) => typeof span.fields[key] === 'string' && span.fields[key] !== '',
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Outside the scrolling region below, so the span you are reading stays
          named while you scroll a long payload. No `sticky` needed — only the
          sibling scrolls. */}
      <div className="flex shrink-0 items-center gap-2.5 border-b px-5 py-3.5">
        <span className="readout text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">Trace inspector</span>
        <span className="h-3 w-px bg-border" aria-hidden />
        <kind.Icon className={cn('size-4 shrink-0', kind.text)} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={labelOf(span)}>
          {labelOf(span)}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
        >
          close
        </button>
      </div>

      {description ? (
        <p className="shrink-0 border-b bg-accent/30 px-5 py-3 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[19rem_minmax(0,1fr)] lg:overflow-hidden">
        <dl className="grid content-start grid-cols-[6rem_1fr] gap-x-4 gap-y-2 border-b px-5 py-4 text-sm lg:overflow-y-auto lg:border-r lg:border-b-0">
          <Row label="step" value={span.step} />
          <Row label="duration" value={span.durationMs ? ms(span.durationMs) : 'instant'} />
          <Row label="offset" value={`+${ms(span.offsetMs)} into the run`} />
          {where ? <Row label="runs in" value={where} /> : null}
          {span.fields.ok === false ? <Row label="outcome" value="failed" danger /> : null}
          {rest.map(([key, value]) => (
            <Row
              key={key}
              label={fieldLabelOf(span, key)}
              value={typeof value === 'string' ? value : JSON.stringify(value)}
            />
          ))}
        </dl>

        <div className="min-w-0 overflow-y-auto pt-4">
          {payloads.length ? payloads.map((key) => {
            const value = String(span.fields[key])
            const presentation = payloadPresentationOf(span, key, value)
            return (
              <Payload
                key={key}
                label={presentation.label}
                meta={presentation.meta}
                value={value}
                danger={key === 'error'}
              />
            )
          }) : <p className="px-5 py-4 text-sm text-muted-foreground">This span has no recorded payload.</p>}
        </div>
      </div>
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
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-5 py-3">
      {rows.map(([label, total]) => {
        const kind = KINDS.find((k) => k.label === label) ?? FALLBACK
        return (
          <span key={label} className="readout flex items-center gap-1.5 text-xs">
            <kind.Icon className={cn('size-3.5 shrink-0', kind.text)} aria-hidden />
            <span className={kind.text}>{label}</span>
            <span className="tabular-nums text-muted-foreground">
              {ms(total)} · {Math.round((total / Math.max(1, totalMs)) * 100)}%
            </span>
          </span>
        )
      })}
    </div>
  )
}
