import type { RunSpan } from '@/shared/lib/types'

const PAYLOAD_LABELS: Record<string, string> = {
  args: 'input',
  result: 'output',
  answer: 'answer',
  tools: 'tools sent',
  error: 'error',
}

export const SPAN_PAYLOAD_KEYS = Object.keys(PAYLOAD_LABELS)

/**
 * The harness snapshots this list whenever it prepares a model turn. Showing
 * the same list twenty times implies twenty actions, so retain only state
 * changes while leaving every raw span intact in the API.
 */
export function collapseUnchangedToolAvailability(spans: RunSpan[]): RunSpan[] {
  let previousSignature: string | null = null
  return spans.filter((span) => {
    if (span.step !== 'llm.tools') return true
    const signature = JSON.stringify([span.fields.count, span.fields.tools])
    if (signature === previousSignature) return false
    previousSignature = signature
    return true
  })
}

/** Human copy for a span; internal event names stay available in the inspector. */
export function labelOf(span: RunSpan): string {
  if (span.step === 'llm.tools') return 'Tools available to model'
  const name = span.fields.name
  return typeof name === 'string' && name ? name : span.step
}

/** The raw event remains visible, while its fields use operator-facing language. */
export function fieldLabelOf(span: RunSpan, key: string): string {
  return span.step === 'llm.tools' && key === 'count' ? 'available tools' : key
}

/** Explain the one trace marker that is most easily mistaken for execution. */
export function descriptionOf(span: RunSpan): string | null {
  if (span.step !== 'llm.tools') return null
  const count = Number(span.fields.count)
  const quantity = Number.isFinite(count) ? `these ${count} tools` : 'these tools'
  return `The model could choose from ${quantity} for this turn. This records availability, not tools actually called. Another row appears only when the list changes.`
}

export function payloadPresentationOf(
  span: RunSpan,
  key: string,
  value: string,
): { label: string; meta: string } {
  const label = PAYLOAD_LABELS[key] ?? key
  if (span.step === 'llm.tools' && key === 'tools') {
    const recordedCount = Number(span.fields.count)
    const count = Number.isFinite(recordedCount)
      ? recordedCount
      : value.split(',').filter((name) => name.trim()).length
    return { label: 'available tool names', meta: `${count.toLocaleString()} total` }
  }
  return { label, meta: `${value.length.toLocaleString()} chars` }
}
