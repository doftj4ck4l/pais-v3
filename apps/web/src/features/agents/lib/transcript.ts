import type { Item, MessageRow, TraceLine, TraceRow } from '@/shared/lib/types'

type ToolItem = Extract<Item, { kind: 'tool' }>
type RenderUiItem = ToolItem & { name: 'render_ui' }
export type TranscriptDisplayItem =
  | Exclude<Item, { kind: 'iteration' | 'tool' }>
  | RenderUiItem
  | { kind: 'tool-group'; tools: ToolItem[] }

/**
 * Turn the runtime-shaped transcript into the quieter narrative shown to users.
 * Consecutive tool calls become one collapsed work block; iteration markers and
 * empty streaming placeholders remain available to run stats but draw no row.
 */
export function groupTranscriptItems(items: Item[]): TranscriptDisplayItem[] {
  const grouped: TranscriptDisplayItem[] = []
  let activeToolGroup: Extract<TranscriptDisplayItem, { kind: 'tool-group' }> | null = null

  for (const item of items) {
    if (item.kind === 'iteration') {
      activeToolGroup = null
      continue
    }
    if (item.kind === 'assistant' && item.text.trim() === '') continue

    if (item.kind === 'tool' && item.name !== 'render_ui') {
      if (activeToolGroup) activeToolGroup.tools.push(item)
      else {
        activeToolGroup = { kind: 'tool-group', tools: [item] }
        grouped.push(activeToolGroup)
      }
      continue
    }

    activeToolGroup = null
    grouped.push(item.kind === 'tool' ? (item as RenderUiItem) : item)
  }

  return grouped
}

/**
 * Apply the user's transcript preference without dropping tool data from the
 * live board or persisted conversation. `render_ui` always remains visible
 * because its arguments are the visual answer, not diagnostic machinery.
 */
export function visibleTranscriptItems(
  items: Item[],
  showToolTrace: boolean,
): TranscriptDisplayItem[] {
  return groupTranscriptItems(
    items.filter(
      (item) =>
        item.kind === 'user' ||
        item.kind === 'assistant' ||
        (showToolTrace && item.kind === 'tool') ||
        (item.kind === 'tool' && item.name === 'render_ui'),
    ),
  )
}

/**
 * How tool arguments are shown: short argument sets read better on one line
 * than pretty-printed. Used for both live events and restored rows so a
 * reloaded transcript is identical to the one you just watched.
 */
export function formatToolArgs(args: unknown): string {
  const compact = JSON.stringify(args ?? {})
  return compact.length > 72 ? JSON.stringify(args, null, 2) : compact
}

/** Rebuild a transcript from stored rows. Unknown kinds are skipped. */
export function itemsFromRows(rows: MessageRow[]): Item[] {
  const items: Item[] = []

  for (const row of rows) {
    const text = row.text ?? ''
    switch (row.kind) {
      case 'user':
      case 'assistant':
        items.push({ kind: row.kind, text })
        break

      case 'thinking':
        items.push({ kind: 'thinking', ...parseThinking(text) })
        break

      case 'iteration': {
        const n = Number(text)
        if (Number.isFinite(n)) items.push({ kind: 'iteration', n })
        break
      }

      case 'tool': {
        try {
          const parsed = JSON.parse(text) as {
            name?: string
            args?: unknown
            result?: string
            ms?: number
            ok?: boolean
          }
          items.push({
            kind: 'tool',
            id: row.id,
            name: parsed.name ?? 'tool',
            args: formatToolArgs(parsed.args),
            result: parsed.result,
            ms: parsed.ms,
            ok: parsed.ok,
          })
        } catch {
          // A malformed row shouldn't blank the whole transcript.
        }
        break
      }
    }
  }

  return items
}

/**
 * A stored reasoning row.
 *
 * Rows written before reasoning was timed hold the thought as bare text, and
 * still do; a timed one holds `{text, ms}`. Anything that isn't that exact
 * shape is the thought itself, so it is returned untouched.
 */
function parseThinking(text: string): { text: string; ms?: number } {
  if (!text.startsWith('{')) return { text }
  try {
    const parsed = JSON.parse(text) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { text?: unknown }).text === 'string' &&
      typeof (parsed as { ms?: unknown }).ms === 'number'
    ) {
      return parsed as { text: string; ms: number }
    }
  } catch {
    // Not JSON — a thought that happens to open with a brace.
  }
  return { text }
}

export function traceFromRows(rows: TraceRow[]): TraceLine[] {
  return rows.map((row) => ({
    ts: row.ts,
    step: row.step,
    fields: safeParse(row.fields),
  }))
}

function safeParse(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}
