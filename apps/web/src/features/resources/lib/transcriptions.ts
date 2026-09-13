import type { TranscriptionRow, TranscriptionSegment, TranscriptionStatus } from '@/shared/lib/types'
import { groupByDate } from '@/features/resources/lib/resource-browser'

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
  return groupByDate(rows, (row) => row.createdAt, options)
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

/** Passage active at a playback position; duplicate timestamps prefer the last. */
export function activeTranscriptSegment(
  segments: TranscriptionSegment[],
  currentTime: number,
): number {
  if (!segments.length || !Number.isFinite(currentTime) || currentTime < segments[0]!.start) return -1
  let low = 0
  let high = segments.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (segments[middle]!.start <= currentTime) low = middle + 1
    else high = middle - 1
  }
  return high
}

export function transcriptTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
