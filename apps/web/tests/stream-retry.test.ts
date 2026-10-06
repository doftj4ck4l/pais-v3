import { describe, expect, it } from 'bun:test'
import {
  StreamHttpError,
  isRetryableStreamError,
  waitForRetry,
} from '../src/features/agents/lib/stream-retry'

describe('isRetryableStreamError', () => {
  it('reconnects a fetch that never reached the server', () => {
    // Safari's message for a severed fetch; Chrome's differs by wording only.
    expect(isRetryableStreamError(new TypeError('Load failed'))).toBe(true)
    expect(isRetryableStreamError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isRetryableStreamError(new Error('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    )
  })

  it('reconnects a transient server failure', () => {
    expect(isRetryableStreamError(new StreamHttpError(500))).toBe(true)
    expect(isRetryableStreamError(new StreamHttpError(502))).toBe(true)
    expect(isRetryableStreamError(new StreamHttpError(429))).toBe(true)
  })

  it('does not reconnect a request the server rejected', () => {
    // A 4xx is the request's own fault, so a second attempt fails identically.
    expect(isRetryableStreamError(new StreamHttpError(400))).toBe(false)
    expect(isRetryableStreamError(new StreamHttpError(401))).toBe(false)
    expect(isRetryableStreamError(new StreamHttpError(404))).toBe(false)
    expect(isRetryableStreamError(new Error('something else'))).toBe(false)
  })
})

describe('waitForRetry', () => {
  it('resolves once the delay elapses', async () => {
    await waitForRetry(5, new AbortController().signal)
  })

  it('rejects with AbortError when the run is stopped mid-wait', async () => {
    const controller = new AbortController()
    const pending = waitForRetry(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForRetry(10_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
