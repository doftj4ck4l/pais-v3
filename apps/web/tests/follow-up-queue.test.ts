import { describe, expect, it } from 'bun:test'
import {
  appendQueuedFollowUp,
  newQueuedFollowUpId,
  shiftQueuedFollowUp,
  shouldQueueFollowUp,
  type QueuedFollowUp,
} from '../src/features/agents/lib/follow-up-queue'

const followUp = (id: string): QueuedFollowUp => ({
  id,
  text: `message ${id}`,
  attachments: { images: [], dataFiles: [] },
})

describe('follow-up queue', () => {
  it('creates an id when randomUUID is unavailable on a private HTTP origin', () => {
    expect(newQueuedFollowUpId(null, () => 1_700_000_000_000, () => 0.25)).toBe(
      'follow-up-loyw3v28-9',
    )
  })

  it('uses randomUUID when the browser provides it', () => {
    expect(newQueuedFollowUpId(() => 'uuid-from-browser')).toBe('uuid-from-browser')
  })

  it('queues only while the selected conversation still has a live run', () => {
    expect(shouldQueueFollowUp(true, true)).toBe(true)
    expect(shouldQueueFollowUp(true, false)).toBe(false)
    expect(shouldQueueFollowUp(false, false)).toBe(false)
  })

  it('keeps messages FIFO without mutating the rendered queue', () => {
    const first = [followUp('a')]
    const queued = appendQueuedFollowUp(first, followUp('b'))
    const shifted = shiftQueuedFollowUp(queued)

    expect(first.map((item) => item.id)).toEqual(['a'])
    expect(shifted.next?.id).toBe('a')
    expect(shifted.remaining.map((item) => item.id)).toEqual(['b'])
  })
})
