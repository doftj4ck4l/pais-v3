import { describe, expect, it } from 'bun:test'
import { hasActiveJobs, recentlyFinished } from '@/features/resources/lib/transcriptions'
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
  it('is true while anything is queued or transcribing, false when settled', () => {
    expect(hasActiveJobs([job({ id: 'a', status: 'queued' })])).toBe(true)
    expect(hasActiveJobs([job({ id: 'a', status: 'transcribing' })])).toBe(true)
    expect(hasActiveJobs([job({ id: 'a', status: 'done' })])).toBe(false)
    expect(hasActiveJobs([job({ id: 'a', status: 'failed' })])).toBe(false)
    expect(hasActiveJobs([])).toBe(false)
  })
})
