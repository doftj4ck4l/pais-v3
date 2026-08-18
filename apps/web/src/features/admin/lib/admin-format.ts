const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const precise = new Intl.NumberFormat()

export function formatMetric(value: number): string {
  return value < 10_000 ? precise.format(value) : compact.format(value)
}

export function formatTokens(input: number, output = 0): string {
  return `${formatMetric(input + output)} tok`
}

export function relativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never active'
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return formatter.format(days, 'day')
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function changeFrom(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? 'No change' : 'New activity'
  const change = Math.round(((current - previous) / previous) * 100)
  return `${change >= 0 ? '+' : ''}${change}% vs prior period`
}
