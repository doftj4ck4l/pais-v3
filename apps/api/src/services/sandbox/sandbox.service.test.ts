import { beforeAll, beforeEach, expect, test } from "bun:test";
import { ensureSchema } from "../../db/client";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import type { CreateOptions, SandboxApi, SandboxInfo, SandboxState } from "./pixelbox-client";
import { PixelboxError } from "./pixelbox-client";
import { sandboxService, setSandboxApiForTests } from "./sandbox.service";

/**
 * A fake Sandbox API tracking which ids exist and their state, so the service's
 * reuse/create/reap decisions are what is under test — not a live pod.
 */
function fakeApi() {
  const live = new Map<string, SandboxState>();
  let counter = 0;
  const api: SandboxApi = {
    async create(_options?: CreateOptions): Promise<SandboxInfo> {
      const sandboxId = `sb-fake-${counter++}`;
      live.set(sandboxId, "ready");
      return { sandboxId, state: "ready" };
    },
    async get(sandboxId: string): Promise<SandboxInfo> {
      const state = live.get(sandboxId);
      if (!state) throw new PixelboxError("NOT_FOUND", `no ${sandboxId}`, 404);
      return { sandboxId, state };
    },
    async delete(sandboxId: string) {
      live.delete(sandboxId);
    },
    execute: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    stat: async () => null,
    list: async () => [],
    createDir: async () => {},
    remove: async () => {},
  };
  return { api, live };
}

let fake: ReturnType<typeof fakeApi>;
const WS = () => `sbx_${Math.random().toString(36).slice(2)}`;

beforeAll(() => ensureSchema());
beforeEach(() => {
  fake = fakeApi();
  setSandboxApiForTests(fake.api);
});

test("acquire creates a remote sandbox and records its id", async () => {
  const ws = WS();
  const sandbox = await sandboxService.acquire(ws);
  expect(sandbox.sandboxId).toBe("sb-fake-0");
  expect(sandbox.workspacePath).toBe("/workspace");
  expect((await sandboxRepository.get(ws))?.containerId).toBe("sb-fake-0");
  expect(fake.live.has("sb-fake-0")).toBe(true);
});

test("acquire reuses a sandbox that is still ready", async () => {
  const ws = WS();
  const first = await sandboxService.acquire(ws);
  const second = await sandboxService.acquire(ws);
  expect(second.sandboxId).toBe(first.sandboxId);
});

test("acquire recreates when the recorded sandbox is gone", async () => {
  const ws = WS();
  const first = await sandboxService.acquire(ws);
  await fake.api.delete(first.sandboxId); // pod vanished server-side
  const second = await sandboxService.acquire(ws);
  expect(second.sandboxId).not.toBe(first.sandboxId);
  expect(fake.live.has(second.sandboxId)).toBe(true);
});

test("reapIdle deletes the remote sandbox and clears the row", async () => {
  const ws = WS();
  const sandbox = await sandboxService.acquire(ws);
  const reaped = await sandboxService.reapIdle(0);
  expect(reaped).toBeGreaterThan(0);
  expect(fake.live.has(sandbox.sandboxId)).toBe(false);
  expect((await sandboxRepository.get(ws))?.containerId).toBeNull();
});

test("reapIdle leaves a warm sandbox alone", async () => {
  const ws = WS();
  const sandbox = await sandboxService.acquire(ws);
  const reaped = await sandboxService.reapIdle(60_000);
  expect(reaped).toBe(0);
  expect(fake.live.has(sandbox.sandboxId)).toBe(true);
});

test("destroy deletes the remote sandbox", async () => {
  const ws = WS();
  const sandbox = await sandboxService.acquire(ws);
  await sandboxService.destroy(ws);
  expect(fake.live.has(sandbox.sandboxId)).toBe(false);
});
