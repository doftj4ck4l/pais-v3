export type DateGroup<T> = {
  key: string
  label: string
  rows: T[]
}

/** Shared calendar folders for the three workspace browsers. */
export function groupByDate<T>(
  rows: T[],
  timestamp: (row: T) => number,
  options: { now?: Date; locale: string; today: string; yesterday: string },
): DateGroup<T>[] {
  const now = options.now ?? new Date()
  const todayKey = localDayKey(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayKey = localDayKey(yesterday)
  const groups = new Map<string, T[]>()

  for (const row of rows) {
    const key = localDayKey(new Date(timestamp(row)))
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, grouped]) => ({
      key,
      rows: grouped,
      label:
        key === todayKey
          ? options.today
          : key === yesterdayKey
            ? options.yesterday
            : new Intl.DateTimeFormat(options.locale, {
                day: 'numeric',
                month: 'short',
                year: key.slice(0, 4) === todayKey.slice(0, 4) ? undefined : 'numeric',
              }).format(new Date(`${key}T12:00:00`)),
    }))
}

function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
