import type { ChatAttachments } from '@/shared/lib/types'

export type QueuedFollowUp = {
  id: string
  text: string
  attachments: ChatAttachments
}

/**
 * `crypto.randomUUID` is restricted to secure browser contexts. Pixelspace's
 * trusted-LAN development URL is plain HTTP, so Chromium exposes `crypto`
 * there without exposing `randomUUID`. A queue id is UI-local and
 * needs uniqueness, not cryptographic secrecy; keep the UUID when available
 * and use a timestamp/random suffix everywhere else.
 */
export function newQueuedFollowUpId(
  uuid: (() => string) | null | undefined = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  if (uuid) {
    try {
      return uuid()
    } catch {
      // A browser may expose the method but reject it on an insecure origin.
    }
  }
  return `follow-up-${now().toString(36)}-${random().toString(36).slice(2, 12)}`
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
