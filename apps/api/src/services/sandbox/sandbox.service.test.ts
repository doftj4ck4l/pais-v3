import { beforeAll, beforeEach, expect, test } from "bun:test";
import { ensureSchema } from "../../db/client";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import type { CreateOptions, ExecRequest, ExecResult, SandboxApi, SandboxInfo, SandboxState } from "./pixelbox-client";
import { PixelboxError } from "./pixelbox-client";
import { sandboxService, setSandboxApiForTests } from "./sandbox.service";

/**
 * A fake Sandbox API tracking which ids exist and their state, so the service's
 * reuse/create/reap decisions are what is under test — not a live pod.
 */
function fakeApi(
  options: {
    executeResult?: ExecResult;
    execute?: SandboxApi["execute"];
    createState?: SandboxState;
    readyAfterGets?: number;
  } = {},
) {
  const live = new Map<string, SandboxState>();
  const files = new Map<string, Uint8Array>();
  const executions: Array<{ sandboxId: string; request: ExecRequest }> = [];
  const lifecycle: string[] = [];
  const prewarmSignals: AbortSignal[] = [];
  let execute = options.execute;
  let counter = 0;
  let gets = 0;
  const api: SandboxApi = {
    async create(_options?: CreateOptions): Promise<SandboxInfo> {
      const sandboxId = `sb-fake-${counter++}`;
      const state = options.createState ?? "ready";
      lifecycle.push(`create:${sandboxId}`);
      live.set(sandboxId, state);
      return { sandboxId, state };
    },
    async get(sandboxId: string): Promise<SandboxInfo> {
      lifecycle.push(`get:${sandboxId}`);
      let state = live.get(sandboxId);
      if (!state) throw new PixelboxError("NOT_FOUND", `no ${sandboxId}`, 404);
      gets += 1;
      if (state === "created" && gets >= (options.readyAfterGets ?? Number.POSITIVE_INFINITY)) {
        state = "ready";
        live.set(sandboxId, state);
      }
      return { sandboxId, state };
    },
    async delete(sandboxId: string) {
      lifecycle.push(`delete:${sandboxId}`);
      live.delete(sandboxId);
      // The live service gives each sandbox its own volume. Deleting it removes
      // the user-site packages and manifest along with the sandbox.
      files.clear();
    },
    execute: async (sandboxId, request, signal) => {
      lifecycle.push(`execute:${sandboxId}`);
      const state = live.get(sandboxId);
      if (state !== "ready" && state !== "running") {
        throw new PixelboxError("SANDBOX_UNAVAILABLE", "Sandbox Pod is not ready.", 503);
      }
      executions.push({ sandboxId, request });
      if (signal) prewarmSignals.push(signal);
      if (execute) return execute(sandboxId, request, signal);
      return options.executeResult ?? { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
    readBytes: async (_sandboxId, path, signal) => {
      if (signal) prewarmSignals.push(signal);
      const bytes = files.get(path);
      if (!bytes) throw new PixelboxError("NOT_FOUND", `no ${path}`, 404);
      return bytes;
    },
    writeBytes: async (_sandboxId, path, content, signal) => {
      if (signal) prewarmSignals.push(signal);
      files.set(path, content);
    },
    stat: async (_sandboxId, path) =>
      files.has(path) ? { kind: "file", size: files.get(path)?.byteLength ?? 0, mtimeMs: Date.now() } : null,
    list: async () => [],
    createDir: async (_sandboxId, _path, _recursive, signal) => {
      if (signal) prewarmSignals.push(signal);
    },
    remove: async () => {},
  };
  return {
    api,
    live,
    files,
    executions,
    lifecycle,
    prewarmSignals,
    setExecute(next: SandboxApi["execute"] | undefined) {
      execute = next;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for test interleaving");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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

test("acquire prewarms a newly created sandbox before recording it", async () => {
  const ws = WS();
  await sandboxService.acquire(ws);

  expect(fake.executions).toHaveLength(1);
  expect(fake.executions[0]?.sandboxId).toBe("sb-fake-0");
  expect(fake.executions[0]?.request.command).toContain("python3 -m pip install");
  expect(fake.executions[0]?.request.command).toContain("pillow==");
  expect(fake.executions[0]?.request.command).toContain("--user");
  expect(fake.executions[0]?.request.cwd).toBe("/workspace");
  expect(fake.executions[0]?.request.env?.PYTHONUSERBASE).toBe("/workspace/.local");
  expect([...fake.files.keys()]).toContain("/workspace/.pixelspace/python-prewarm-manifest");
  expect(fake.prewarmSignals).toHaveLength(4);
  expect(fake.prewarmSignals.every((signal) => signal === fake.prewarmSignals[0])).toBe(true);
});

test("acquire waits for a created sandbox to become ready before prewarming it", async () => {
  const ws = WS();
  fake = fakeApi({ createState: "created", readyAfterGets: 1 });
  setSandboxApiForTests(fake.api);

  await sandboxService.acquire(ws);

  expect(fake.lifecycle.slice(0, 3)).toEqual(["create:sb-fake-0", "get:sb-fake-0", "execute:sb-fake-0"]);
});

test("acquire reuses a sandbox that is still ready", async () => {
  const ws = WS();
  const first = await sandboxService.acquire(ws);
  const second = await sandboxService.acquire(ws);
  expect(second.sandboxId).toBe(first.sandboxId);
  expect(fake.executions).toHaveLength(1);
});

test("concurrent acquire calls share one cold sandbox bootstrap", async () => {
  const ws = WS();
  const [first, second] = await Promise.all([sandboxService.acquire(ws), sandboxService.acquire(ws)]);

  expect(second).toEqual(first);
  expect(fake.lifecycle.filter((event) => event.startsWith("create:"))).toHaveLength(1);
  expect(fake.executions).toHaveLength(1);
});

test("aborting one acquire waiter leaves the shared bootstrap available to other callers", async () => {
  const ws = WS();
  const install = deferred<ExecResult>();
  fake = fakeApi({ execute: async () => install.promise });
  setSandboxApiForTests(fake.api);
  const controller = new AbortController();

  const aborted = sandboxService.acquire(ws, controller.signal);
  const waiting = sandboxService.acquire(ws);
  await waitFor(() => fake.executions.length === 1);
  controller.abort();
  await expect(aborted).rejects.toHaveProperty("name", "AbortError");

  const joinedAfterAbort = sandboxService.acquire(ws);
  install.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
  const [first, second] = await Promise.all([waiting, joinedAfterAbort]);

  expect(second).toEqual(first);
  expect(fake.lifecycle.filter((event) => event.startsWith("create:"))).toHaveLength(1);
  expect(fake.executions).toHaveLength(1);
});

test("acquire deletes a cold sandbox when prewarming fails", async () => {
  const ws = WS();
  fake = fakeApi({
    executeResult: { stdout: "", stderr: "package not found", exitCode: 1, timedOut: false },
  });
  setSandboxApiForTests(fake.api);

  await expect(sandboxService.acquire(ws)).rejects.toThrow("package not found");
  expect(fake.live.has("sb-fake-0")).toBe(false);
  expect(await sandboxRepository.get(ws)).toBeUndefined();
});

test("acquire deletes a cold sandbox when the remote install times out", async () => {
  const ws = WS();
  fake = fakeApi({
    executeResult: { stdout: "partial", stderr: "", exitCode: -1, timedOut: true },
  });
  setSandboxApiForTests(fake.api);

  await expect(sandboxService.acquire(ws)).rejects.toThrow("prewarm timed out");
  expect(fake.live.has("sb-fake-0")).toBe(false);
  expect(await sandboxRepository.get(ws)).toBeUndefined();
});

test("acquire bounds a hanging prewarm request and cleans up the cold sandbox", async () => {
  const ws = WS();
  fake = fakeApi({
    execute: async (_sandboxId, _request, signal) =>
      new Promise<ExecResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  setSandboxApiForTests(fake.api, { prewarmDeadlineMs: 5 });

  await expect(sandboxService.acquire(ws)).rejects.toThrow("transport timed out");
  expect(fake.live.has("sb-fake-0")).toBe(false);
  expect(await sandboxRepository.get(ws)).toBeUndefined();
});

test("acquire deletes a cold sandbox that enters a terminal state before readiness", async () => {
  const ws = WS();
  fake = fakeApi({ createState: "error" });
  setSandboxApiForTests(fake.api);

  await expect(sandboxService.acquire(ws)).rejects.toThrow("entered terminal state error");
  expect(fake.lifecycle).toEqual(["create:sb-fake-0", "delete:sb-fake-0"]);
  expect(await sandboxRepository.get(ws)).toBeUndefined();
});

test("acquire recreates when the recorded sandbox is gone", async () => {
  const ws = WS();
  const first = await sandboxService.acquire(ws);
  await fake.api.delete(first.sandboxId); // pod vanished server-side
  const second = await sandboxService.acquire(ws);
  expect(second.sandboxId).not.toBe(first.sandboxId);
  expect(fake.live.has(second.sandboxId)).toBe(true);
  expect(fake.executions).toHaveLength(2);
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
  await sandboxService.destroy(ws);
});

test("reapIdle skips a reusable sandbox while its prewarm is in progress", async () => {
  const ws = WS();
  const sandbox = await sandboxService.acquire(ws);
  fake.files.clear();
  const install = deferred<ExecResult>();
  fake.setExecute(async () => install.promise);

  const reacquired = sandboxService.acquire(ws);
  await waitFor(() => fake.executions.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 2));

  expect(await sandboxService.reapIdle(0)).toBe(0);
  expect(fake.live.has(sandbox.sandboxId)).toBe(true);

  install.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
  expect((await reacquired).sandboxId).toBe(sandbox.sandboxId);
});

test("destroy deletes the remote sandbox", async () => {
  const ws = WS();
  const sandbox = await sandboxService.acquire(ws);
  await sandboxService.destroy(ws);
  expect(fake.live.has(sandbox.sandboxId)).toBe(false);
});
