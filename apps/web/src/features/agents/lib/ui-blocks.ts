/**
 * Generative-UI "blocks": the model emits a fenced ```ui code block carrying a
 * JSON spec that names a component from an app-owned catalog, and the console
 * renders *our* real React component for it.
 *
 * This is the A2UI pattern without the A2UI dependency: the model never authors
 * markup, only declarative JSON. Everything it sends is validated against the
 * catalog here before a component ever sees it — an unknown component, a missing
 * prop, or malformed JSON degrades to a visible fallback, never a thrown render.
 *
 * A message is therefore not one markdown blob any more but a sequence of
 * segments: prose, then a block, then more prose. `parseMessage` splits on the
 * fence and hands each ui block through `validateSpec`, so the transcript can
 * map segments to elements without knowing the catalog.
 */

export type UiSpec =
  | { component: 'chart'; props: ChartProps }
  | { component: 'table'; props: TableProps }
  | { component: 'stat'; props: StatProps }
  | { component: 'card'; props: CardProps }

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'ui'; spec: UiSpec }
  /** A block still arriving mid-stream — closing fence not seen yet. */
  | { kind: 'ui-pending' }
  /** Parsed but rejected by the catalog; the raw JSON is kept so it can be shown. */
  | { kind: 'ui-error'; raw: string; reason: string }

export type ChartProps = {
  type: 'bar' | 'line' | 'area' | 'pie' | 'scatter'
  data: Array<Record<string, unknown>>
  /** Category/x-axis key present on every row. */
  x: string
  /** One numeric key, or several for a multi-series chart. */
  y: string | string[]
  title?: string
}

export type TableProps = {
  columns: Array<{ key: string; label?: string; align?: 'left' | 'right' | 'center' }>
  rows: Array<Record<string, unknown>>
  caption?: string
}

export type StatProps = {
  label: string
  value: string | number
  /** Signed change; `trend` colours it when the caller doesn't say. */
  delta?: string | number
  trend?: 'up' | 'down' | 'flat'
  help?: string
}

export type CardProps = {
  title?: string
  /** Markdown; rendered through the same sanitised path as the rest of the chat. */
  body?: string
  fields?: Array<{ label: string; value: string }>
  accent?: 'default' | 'primary' | 'success' | 'warning' | 'destructive'
}

// A closed ui fence: ```ui\n<json>\n```. JSON never contains a fence of its own,
// so a non-greedy match to the next ``` is safe and keeps the split O(n).
const UI_BLOCK = /```ui[ \t]*\r?\n([\s\S]*?)```/g

// A fence that has opened but not closed — only meaningful at the very end of a
// message while it streams. Rendering the raw ```ui as markdown would flash a
// code block that becomes a chart a token later, so it gets a placeholder.
const UI_BLOCK_OPEN = /```ui[ \t]*\r?\n([\s\S]*)$/

export function parseMessage(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0

  for (const match of text.matchAll(UI_BLOCK)) {
    const start = match.index ?? 0
    if (start > last) pushMarkdown(segments, text.slice(last, start))
    segments.push(toUiSegment(match[1]))
    last = start + match[0].length
  }

  const rest = text.slice(last)
  const open = rest.match(UI_BLOCK_OPEN)
  if (open) {
    const before = rest.slice(0, open.index ?? 0)
    if (before.trim()) pushMarkdown(segments, before)
    segments.push({ kind: 'ui-pending' })
  } else if (rest) {
    pushMarkdown(segments, rest)
  }

  // A message with no blocks stays a single markdown segment — the common case,
  // and identical to the old single-blob render.
  return segments.length ? segments : [{ kind: 'markdown', text }]
}

/** True when a message carries at least one ui block — lets callers skip the split. */
export function hasUiBlock(text: string): boolean {
  UI_BLOCK.lastIndex = 0
  return UI_BLOCK.test(text) || UI_BLOCK_OPEN.test(text)
}

function pushMarkdown(segments: Segment[], text: string) {
  if (text.trim()) segments.push({ kind: 'markdown', text })
}

function toUiSegment(raw: string): Segment {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'ui-error', raw, reason: 'not valid JSON' }
  }
  const spec = validateSpec(parsed)
  return spec ? { kind: 'ui', spec } : { kind: 'ui-error', raw, reason: 'unknown or malformed component' }
}

export function validateSpec(value: unknown): UiSpec | null {
  if (!isRecord(value)) return null
  const props = value.props
  if (!isRecord(props)) return null
  switch (value.component) {
    case 'chart':
      return validateChart(props) ? { component: 'chart', props } : null
    case 'table':
      return validateTable(props) ? { component: 'table', props } : null
    case 'stat':
      return validateStat(props) ? { component: 'stat', props } : null
    case 'card':
      return validateCard(props) ? { component: 'card', props } : null
    default:
      return null
  }
}

const CHART_TYPES = new Set(['bar', 'line', 'area', 'pie', 'scatter'])

function validateChart(p: Record<string, unknown>): p is ChartProps {
  if (typeof p.type !== 'string' || !CHART_TYPES.has(p.type)) return false
  if (!isRowArray(p.data) || p.data.length === 0) return false
  if (typeof p.x !== 'string') return false
  const y = p.y
  const yOk = typeof y === 'string' || (Array.isArray(y) && y.length > 0 && y.every((k) => typeof k === 'string'))
  if (!yOk) return false
  if (p.title !== undefined && typeof p.title !== 'string') return false
  return true
}

function validateTable(p: Record<string, unknown>): p is TableProps {
  if (!Array.isArray(p.columns) || p.columns.length === 0) return false
  const colsOk = p.columns.every((c) => isRecord(c) && typeof c.key === 'string')
  if (!colsOk) return false
  if (!isRowArray(p.rows)) return false
  if (p.caption !== undefined && typeof p.caption !== 'string') return false
  return true
}

function validateStat(p: Record<string, unknown>): p is StatProps {
  if (typeof p.label !== 'string') return false
  if (typeof p.value !== 'string' && typeof p.value !== 'number') return false
  return true
}

function validateCard(p: Record<string, unknown>): p is CardProps {
  if (p.title !== undefined && typeof p.title !== 'string') return false
  if (p.body !== undefined && typeof p.body !== 'string') return false
  if (p.fields !== undefined) {
    if (!Array.isArray(p.fields)) return false
    if (!p.fields.every((f) => isRecord(f) && typeof f.label === 'string' && typeof f.value === 'string')) return false
  }
  // A card with nothing in it is not worth a box.
  return Boolean(p.title || p.body || (Array.isArray(p.fields) && p.fields.length))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRowArray(v: unknown): v is Array<Record<string, unknown>> {
  return Array.isArray(v) && v.every(isRecord)
}
