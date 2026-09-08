import type { TranscriptionRow } from '@/shared/lib/types'

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
  return rows.some((row) => row.status === 'queued' || row.status === 'transcribing')
}
