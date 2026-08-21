/**
 * The generative-UI catalog, API side.
 *
 * This is the model-facing half of the same contract the console renders
 * (`apps/web/src/features/agents/lib/ui-blocks.ts`). The `render_ui` tool runs a
 * spec through here before it ever reaches the transcript, so a malformed block
 * comes back to the model as a list of concrete problems it can fix and retry —
 * rather than failing silently in the browser the way an unvalidated fence does.
 *
 * The two validators must stay in step: a prop this file accepts but the web
 * catalog rejects is a block the model is told is fine and the user never sees.
 * Keep the component list and required props identical on both sides.
 */

export type UiValidation = { ok: true } | { ok: false; errors: string[] }

const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'scatter'] as const

export function validateUiSpec(component: unknown, props: unknown): UiValidation {
  if (typeof component !== 'string') {
    return fail('`component` is required and must be a string')
  }
  if (!isRecord(props)) {
    return fail('`props` is required and must be an object')
  }
  switch (component) {
    case 'chart':
      return validateChart(props)
    case 'table':
      return validateTable(props)
    case 'stat':
      return validateStat(props)
    case 'card':
      return validateCard(props)
    default:
      return fail(`unknown component "${component}" — use one of: chart, table, stat, card`)
  }
}

function validateChart(p: Record<string, unknown>): UiValidation {
  const errors: string[] = []
  if (typeof p.type !== 'string' || !CHART_TYPES.includes(p.type as never)) {
    errors.push(`chart.type must be one of: ${CHART_TYPES.join(', ')}`)
  }
  if (!isRowArray(p.data) || p.data.length === 0) {
    errors.push('chart.data must be a non-empty array of row objects')
  }
  if (typeof p.x !== 'string') {
    errors.push('chart.x must be a string naming the category key present on every row')
  }
  const y = p.y
  const yOk =
    typeof y === 'string' || (Array.isArray(y) && y.length > 0 && y.every((k) => typeof k === 'string'))
  if (!yOk) errors.push('chart.y must be a metric key, or a non-empty array of metric keys')
  // Catch the common mistake of naming a key nothing in the data actually has.
  if (isRowArray(p.data) && typeof p.x === 'string' && yOk) {
    const keys = new Set(Object.keys(p.data[0] ?? {}))
    const wanted = [p.x, ...(Array.isArray(y) ? y : [y as string])]
    const missing = wanted.filter((k) => !keys.has(k))
    if (missing.length) errors.push(`data rows have no key(s): ${missing.join(', ')}`)
  }
  return done(errors)
}

function validateTable(p: Record<string, unknown>): UiValidation {
  const errors: string[] = []
  if (!Array.isArray(p.columns) || p.columns.length === 0) {
    errors.push('table.columns must be a non-empty array of { key, label?, align? }')
  } else if (!p.columns.every((c) => isRecord(c) && typeof c.key === 'string')) {
    errors.push('every table column needs a string `key`')
  }
  if (!isRowArray(p.rows)) errors.push('table.rows must be an array of row objects keyed by column key')
  return done(errors)
}

function validateStat(p: Record<string, unknown>): UiValidation {
  const errors: string[] = []
  if (typeof p.label !== 'string') errors.push('stat.label must be a string')
  if (typeof p.value !== 'string' && typeof p.value !== 'number') {
    errors.push('stat.value must be a string or number')
  }
  return done(errors)
}

function validateCard(p: Record<string, unknown>): UiValidation {
  const errors: string[] = []
  if (p.title !== undefined && typeof p.title !== 'string') errors.push('card.title must be a string')
  if (p.body !== undefined && typeof p.body !== 'string') errors.push('card.body must be a string (markdown)')
  if (p.fields !== undefined) {
    if (!Array.isArray(p.fields) || !p.fields.every((f) => isRecord(f) && typeof f.label === 'string' && typeof f.value === 'string')) {
      errors.push('card.fields must be an array of { label, value } strings')
    }
  }
  if (!p.title && !p.body && !(Array.isArray(p.fields) && p.fields.length)) {
    errors.push('a card needs at least one of: title, body, fields')
  }
  return done(errors)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRowArray(v: unknown): v is Array<Record<string, unknown>> {
  return Array.isArray(v) && v.every(isRecord)
}

function fail(msg: string): UiValidation {
  return { ok: false, errors: [msg] }
}

function done(errors: string[]): UiValidation {
  return errors.length ? { ok: false, errors } : { ok: true }
}
