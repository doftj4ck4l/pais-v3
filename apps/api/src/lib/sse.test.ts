import { describe, expect, it } from "bun:test";
import type { SSEStreamingApi } from "hono/streaming";
import { startHeartbeat } from "./sse";

/** Records what was written, and can fail writes like a hung-up client. */
function fakeStream(failing = false) {
  const frames: { event?: string; data: string }[] = [];
  const stream = {
    async writeSSE(frame: { event?: string; data: string }) {
      if (failing) throw new Error("client gone");
      frames.push(frame);
    },
  } as unknown as SSEStreamingApi;
  return { stream, frames };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startHeartbeat", () => {
  it("emits a ping while the stream is otherwise silent", async () => {
    const { stream, frames } = fakeStream();
    const stop = startHeartbeat(stream, 20);
    await wait(70);
    stop();

    // Silence is what closes a connection; the run itself sends nothing here.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((f) => f.event === "ping")).toBe(true);
  });

  it("stops when told to, so it cannot outlive the run", async () => {
    const { stream, frames } = fakeStream();
    const stop = startHeartbeat(stream, 20);
    await wait(50);
    stop();
    const afterStop = frames.length;

    await wait(60);
    expect(frames.length).toBe(afterStop);
  });

  it("survives a client that has already disconnected", async () => {
    // A write to a dead stream must not reject into an unhandled rejection.
    const { stream } = fakeStream(true);
    const stop = startHeartbeat(stream, 10);
    await wait(40);
    stop();
    expect(true).toBe(true);
  });

  it("sends empty data, so a client parsing frames skips it", async () => {
    const { stream, frames } = fakeStream();
    const stop = startHeartbeat(stream, 10);
    await wait(30);
    stop();
    expect(frames[0]!.data).toBe("");
  });
});
