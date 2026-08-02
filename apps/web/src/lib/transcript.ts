import type { Item, MessageRow, TraceLine, TraceRow } from '@/lib/types'

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
      case 'thinking':
        items.push({ kind: row.kind, text })
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
          }
          items.push({
            kind: 'tool',
            id: row.id,
            name: parsed.name ?? 'tool',
            args: formatToolArgs(parsed.args),
            result: parsed.result,
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
