import type { TranscriptionRow, TranscriptionStatus } from '@/shared/lib/types'

export type TranscriptionDateGroup = {
  key: string
  label: string
  rows: TranscriptionRow[]
}

/**
 * Which audio jobs turned `done` between one poll and the next.
 *
 * Pure so the "just finished" banner can be tested without rendering the panel:
 * this is the whole change-detection contract — nothing else compares a poll to
 * a previous one.
 */
export function recentlyFinished(
  previous: TranscriptionRow[],
  next: TranscriptionRow[],
): TranscriptionRow[] {
  const before = new Map(previous.map((row) => [row.id, row]))
  return next.filter((row) => row.status === 'done' && before.get(row.id)?.status !== 'done')
}

/** Queued and transcribing rows are the ones worth polling for. */
export function hasActiveJobs(rows: TranscriptionRow[]): boolean {
  return rows.some(
    (row) => row.status === 'queued' || row.status === 'transcribing' || row.status === 'indexing',
  )
}

/** Calendar folders in newest-first order, independent of the row's time of day. */
export function groupTranscriptionsByDate(
  rows: TranscriptionRow[],
  options: { now?: Date; locale: string; today: string; yesterday: string },
): TranscriptionDateGroup[] {
  const now = options.now ?? new Date()
  const todayKey = localDayKey(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayKey = localDayKey(yesterday)
  const groups = new Map<string, TranscriptionRow[]>()

  for (const row of rows) {
    const key = localDayKey(new Date(row.createdAt))
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

export function transcriptionProgress(status: TranscriptionStatus): number {
  switch (status) {
    case 'queued':
      return 24
    case 'transcribing':
      return 62
    case 'indexing':
      return 88
    case 'done':
    case 'failed':
      return 100
  }
}

function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
