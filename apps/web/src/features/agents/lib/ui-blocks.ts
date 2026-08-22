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
  /** Single colour override for the whole chart (hex, rgb()/hsl(), or a CSS name). */
  color?: string
  /** Per-series (or per-slice) colour overrides; wraps if shorter than the data. */
  colors?: string[]
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

// Every catalog spec carries this key, so its presence is the cheap gate that
// decides whether a message needs the fuller parse at all. A prose mention of
// the word is a false positive that costs one no-op parse and renders the same.
const SPEC_MARKER = '"component"'

// A fenced code block, tag captured. We accept a spec whichever tag the model
// reaches for — ```ui, ```json, or a bare ``` — because models do not emit an
// exact fence reliably; what makes a block a component is that it *validates*,
// not how it was tagged. A closing ``` cannot appear inside JSON, so the
// non-greedy match to the next fence is safe.
const FENCE = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g

// The same fence still open at end of message — only meaningful mid-stream.
const FENCE_OPEN = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*)$/

export function parseMessage(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0

  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0
    // Text before the fence can itself carry a bare (unfenced) spec.
    if (start > last) scanBare(text.slice(last, start), segments)
    segments.push(...fenceSegment(match[1].toLowerCase(), match[2], match[0]))
    last = start + match[0].length
  }

  const rest = text.slice(last)
  const open = rest.match(FENCE_OPEN)
  if (open) {
    const before = rest.slice(0, open.index ?? 0)
    if (before.trim()) scanBare(before, segments)
    const lang = open[1].toLowerCase()
    // A ```ui fence, or any fence already carrying a spec marker, is a block
    // still arriving — show a placeholder rather than flash its raw JSON. A
    // plain code fence still streaming is just markdown.
    if (lang === 'ui' || open[2].includes(SPEC_MARKER)) segments.push({ kind: 'ui-pending' })
    else pushMarkdown(segments, rest)
  } else if (rest) {
    scanBare(rest, segments)
  }

  // A message with no blocks stays a single markdown segment — the common case,
  // and identical to the old single-blob render.
  return segments.length ? segments : [{ kind: 'markdown', text }]
}

/** Cheap gate: only a message that could contain a spec takes the fuller parse. */
export function hasUiBlock(text: string): boolean {
  return text.includes(SPEC_MARKER)
}

/**
 * A fenced block becomes a component when its body validates, whatever the tag.
 * A block tagged `ui` that does *not* validate is surfaced as an error so a
 * malformed spec is visible rather than shown as a code listing; any other tag
 * that does not validate is left exactly as the model wrote it — a real code
 * block the user wanted to read.
 */
function fenceSegment(lang: string, body: string, whole: string): Segment[] {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const spec = validateSpec(JSON.parse(trimmed))
      if (spec) return [{ kind: 'ui', spec }]
    } catch {
      // falls through to the tag-based handling below
    }
  }
  if (lang === 'ui') return [{ kind: 'ui-error', raw: body, reason: 'malformed component' }]
  return [{ kind: 'markdown', text: whole }]
}

/**
 * Pull bare (unfenced) specs out of a run of text. A model often emits the JSON
 * object on its own line with no fence at all, so a balanced-brace scan finds
 * each `{…}` that both mentions the marker and validates, and leaves everything
 * around it as markdown. Only a validated object is lifted out — ordinary prose
 * and non-spec JSON stay untouched.
 */
function scanBare(text: string, segments: Segment[]) {
  let i = 0
  let cut = 0
  while (i < text.length) {
    if (text[i] !== '{') {
      i++
      continue
    }
    const end = balancedEnd(text, i)
    if (end === null) break // an unterminated object — leave the rest to markdown
    const candidate = text.slice(i, end)
    if (candidate.includes(SPEC_MARKER)) {
      try {
        const spec = validateSpec(JSON.parse(candidate))
        if (spec) {
          pushMarkdown(segments, text.slice(cut, i))
          segments.push({ kind: 'ui', spec })
          cut = end
        }
      } catch {
        // not a spec after all — treated as ordinary text
      }
    }
    i = end // skip the whole object either way, so nested braces are not rescanned
  }
  pushMarkdown(segments, text.slice(cut))
}

/** Index just past the `}` that closes the object opened at `start`, respecting strings. */
function balancedEnd(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i + 1
  }
  return null
}

function pushMarkdown(segments: Segment[], text: string) {
  if (text.trim()) segments.push({ kind: 'markdown', text })
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
  if (p.color !== undefined && !isSafeColor(p.color)) return false
  if (p.colors !== undefined && (!Array.isArray(p.colors) || !p.colors.every(isSafeColor))) return false
  return true
}

// A colour goes straight into an SVG `fill`, so only shapes that cannot smuggle
// anything else through are allowed: a hex, an rgb()/hsl() function, or a bare
// CSS colour name. This is the same allowlist the API validator enforces.
const HEX = /^#[0-9a-f]{3,8}$/i
const FUNC = /^(rgb|hsl)a?\([\d.,%\s/]+\)$/i
const NAME = /^[a-z]+$/i
export function isSafeColor(v: unknown): v is string {
  return typeof v === 'string' && (HEX.test(v) || FUNC.test(v) || NAME.test(v))
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
