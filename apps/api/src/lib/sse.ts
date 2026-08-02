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

/** Best-effort terminator — the client may already be gone. */
export async function closeStream(stream: SSEStreamingApi): Promise<void> {
  try {
    await stream.writeSSE({ event: "close", data: "{}" });
  } catch {
    // client disconnected first; nothing to do
  }
}
