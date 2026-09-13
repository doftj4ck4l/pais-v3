import type { ChatAttachments } from '@/shared/lib/types'

export type QueuedFollowUp = {
  id: string
  text: string
  attachments: ChatAttachments
}

/** A live controller is the source of truth during React's end-of-run render. */
export function shouldQueueFollowUp(isRunning: boolean, hasLiveRun: boolean): boolean {
  return isRunning && hasLiveRun
}

export function appendQueuedFollowUp(
  queue: QueuedFollowUp[],
  followUp: QueuedFollowUp,
): QueuedFollowUp[] {
  return [...queue, followUp]
}

export function shiftQueuedFollowUp(queue: QueuedFollowUp[]): {
  next: QueuedFollowUp | null
  remaining: QueuedFollowUp[]
} {
  return queue.length
    ? { next: queue[0]!, remaining: queue.slice(1) }
    : { next: null, remaining: queue }
}
