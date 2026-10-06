/**
 * A dropped stream is reconnected this many times before the run is shown as
 * failed. A long run's connection can be severed by the browser or a proxy at a
 * fixed ceiling; the run itself is unaffected, so reconnecting is the honest
 * response rather than reporting a failure the user did not cause.
 */
export const MAX_STREAM_RETRIES = 4
/** Base backoff between reconnects; doubles with each attempt. */
export const STREAM_RETRY_BASE_MS = 1_000

/** A `/api/chat` response that came back non-2xx, carrying its status. */
export class StreamHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'StreamHttpError'
    this.status = status
  }
}

/**
 * Whether a failed stream is worth reconnecting. A connection that never reached
 * the server (Safari says "Load failed", Chrome "Failed to fetch") or a 5xx may be
 * transient, so a reconnect can succeed. A 4xx is the request's own fault and a
 * second attempt would fail identically.
 */
export function isRetryableStreamError(err: Error): boolean {
  if (err instanceof StreamHttpError) return err.status >= 500 || err.status === 429
  return err instanceof TypeError || /load failed|failed to fetch|networkerror/i.test(err.message)
}

/** A cancellable pause between reconnect attempts. */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
