import { describe, expect, it } from 'bun:test'
import {
  groupTranscriptionsByDate,
  hasActiveJobs,
  recentlyFinished,
  activeTranscriptSegment,
  transcriptTimestamp,
  transcriptionProgress,
} from '@/features/resources/lib/transcriptions'
import type { TranscriptionRow } from '@/shared/lib/types'

const job = (partial: Partial<TranscriptionRow>): TranscriptionRow => ({
  id: 'trx_1',
  workspaceId: 'ws1',
  title: 'call.mp3',
  bytes: 1024,
  status: 'queued',
  model: null,
  error: null,
  documentId: null,
  hasAudio: false,
  createdAt: 1,
  updatedAt: 1,
  ...partial,
})

describe('recentlyFinished', () => {
  it('picks rows that newly became done in this poll', () => {
    const previous = [
      job({ id: 'a', status: 'transcribing' }),
      job({ id: 'b', status: 'queued' }),
      job({ id: 'c', status: 'done' }), // done before the page opened? no — before this poll
    ]
    const next = [
      job({ id: 'a', status: 'done' }),
      job({ id: 'b', status: 'queued' }),
      job({ id: 'c', status: 'done' }),
    ]

    const finished = recentlyFinished(previous, next)
    expect(finished.map((r) => r.id)).toEqual(['a'])
    expect(finished[0]!.title).toBe('call.mp3')
  })

  it('does not banner a job that was already done', () => {
    const done = job({ id: 'a', status: 'done' })
    expect(recentlyFinished([done], [done])).toHaveLength(0)
  })

  it('does not banner a brand-new failed job', () => {
    expect(recentlyFinished([], [job({ id: 'a', status: 'failed' })])).toHaveLength(0)
  })
})

describe('hasActiveJobs', () => {
  it('is true while anything is queued, transcribing, or indexing, false when settled', () => {
    expect(hasActiveJobs([job({ id: 'a', status: 'queued' })])).toBe(true)
    expect(hasActiveJobs([job({ id: 'a', status: 'transcribing' })])).toBe(true)
    expect(hasActiveJobs([job({ id: 'a', status: 'indexing' })])).toBe(true)
    expect(hasActiveJobs([job({ id: 'a', status: 'done' })])).toBe(false)
    expect(hasActiveJobs([job({ id: 'a', status: 'failed' })])).toBe(false)
    expect(hasActiveJobs([])).toBe(false)
  })
})

describe('groupTranscriptionsByDate', () => {
  it('builds newest-first calendar folders with friendly recent labels', () => {
    const now = new Date(2026, 8, 10, 10)
    const rows = [
      job({ id: 'today', createdAt: new Date(2026, 8, 10, 8).getTime() }),
      job({ id: 'yesterday', createdAt: new Date(2026, 8, 9, 20).getTime() }),
      job({ id: 'older', createdAt: new Date(2026, 7, 30, 12).getTime() }),
    ]

    const groups = groupTranscriptionsByDate(rows, {
      now,
      locale: 'en',
      today: 'Today',
      yesterday: 'Yesterday',
    })

    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'Aug 30'])
    expect(groups.map((group) => group.rows[0]!.id)).toEqual(['today', 'yesterday', 'older'])
  })
})

describe('transcriptionProgress', () => {
  it('maps persisted stages to a monotonic progress track', () => {
    expect(['queued', 'transcribing', 'indexing', 'done'].map((status) =>
      transcriptionProgress(status as TranscriptionRow['status']),
    )).toEqual([24, 62, 88, 100])
  })
})

describe('audio-follow transcript helpers', () => {
  const segments = [
    { start: 0, text: 'Opening' },
    { start: 4.5, text: 'Decision' },
    { start: 12, text: 'Close' },
  ]

  it('selects the most recent passage at the playback time', () => {
    expect(activeTranscriptSegment(segments, 0)).toBe(0)
    expect(activeTranscriptSegment(segments, 4.49)).toBe(0)
    expect(activeTranscriptSegment(segments, 4.5)).toBe(1)
    expect(activeTranscriptSegment(segments, 99)).toBe(2)
    expect(activeTranscriptSegment(segments, -1)).toBe(-1)
  })

  it('formats short and hour-long recording times', () => {
    expect(transcriptTimestamp(65)).toBe('01:05')
    expect(transcriptTimestamp(3_661)).toBe('01:01:01')
  })
})
