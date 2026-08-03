import type { SSEStreamingApi } from "hono/streaming";

/**
 * Adapt a Hono SSE stream into the `emit(event)` callback the agent loop wants.
 * The event's own `type` becomes the SSE event name; the whole event is the
 * JSON payload.
 */
export function createEmitter(stream: SSEStreamingApi) {
  return (event: { type: string } & Record<string, unknown>) => {
    void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
  };
}

/**
 * Keep a quiet stream alive.
 *
 * A run is silent for as long as its slowest tool takes, and both Bun's
 * `idleTimeout` and any proxy in front of it close a connection that sends
 * nothing. Raising the timeout only moves the ceiling — a comment frame every
 * 15s removes it, because idle time never accumulates.
 *
 * SSE comments (`: text`) are part of the protocol and ignored by clients, so
 * this costs nothing on the receiving end.
 *
 * Returns a stop function; callers must call it when the run settles.
 */
export function startHeartbeat(stream: SSEStreamingApi, everyMs = 15_000): () => void {
  const timer = setInterval(() => {
    // A write to a closed stream is normal here: the client may have hung up
    // between ticks, and the run's own cleanup handles that case.
    void stream.writeSSE({ data: "", event: "ping" }).catch(() => {});
  }, everyMs);

  // Never hold the process open for a heartbeat alone.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** Best-effort terminator — the client may already be gone. */
export async function closeStream(stream: SSEStreamingApi): Promise<void> {
  try {
    await stream.writeSSE({ event: "close", data: "{}" });
  } catch {
    // client disconnected first; nothing to do
  }
}
