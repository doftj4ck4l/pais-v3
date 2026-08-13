/**
 * Splitting the agent list into days.
 *
 * Grouped by day key rather than by walking the array. The list is newest-first
 * — restored runs in that order, a newly spawned one prepended — but nothing
 * enforces that, and walking the array would print "Today", then "Yesterday",
 * then "Today" again the moment one entry sat out of order.
 *
 * Days are ordered newest first, and so is each day's contents. Sorting here
 * rather than trusting the caller's array is deliberate: the list is assembled
 * from two sources — rows restored from the API and runs spawned in this tab —
 * and a new chat landing at the bottom of Today because one of them appended is
 * not a bug the reader can see the cause of. There is one rule now, in one
 * place: newest first, everywhere.
 */

export type DayGroup<T> = { key: string; label: string; items: T[] }

const DAY_MS = 86_400_000

/** Local midnight, not UTC: "today" means the reader's today. */
function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/**
 * What to call a day, relative to now.
 *
 * Weekday names only inside the last week — "Sunday" six days ago is helpful,
 * "Sunday" five weeks ago is a riddle. The year appears only when it is not
 * this one, which is the difference between a label and a form field.
 */
export function dayLabel(at: number, now: Date = new Date()): string {
  const today = startOfDay(now)
  const day = startOfDay(new Date(at))
  const daysAgo = Math.round((today - day) / DAY_MS)

  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo < 7) return new Date(at).toLocaleDateString([], { weekday: 'long' })

  const sameYear = new Date(at).getFullYear() === now.getFullYear()
  return new Date(at).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function groupByDay<T>(
  items: T[],
  startedAt: (item: T) => number,
  now: Date = new Date(),
): DayGroup<T>[] {
  const groups = new Map<number, T[]>()

  for (const item of items) {
    const day = startOfDay(new Date(startedAt(item)))
    const existing = groups.get(day)
    if (existing) existing.push(item)
    else groups.set(day, [item])
  }

  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([day, group]) => ({
      key: String(day),
      label: dayLabel(day, now),
      items: [...group].sort((a, b) => startedAt(b) - startedAt(a)),
    }))
}
