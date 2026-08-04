import { expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ensureSchema } from "../../db/client";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import { isRunning } from "./docker";
import { sandboxService } from "./sandbox.service";

const WS = `sbx_ws_${Date.now()}`;

/** Let the clock advance so a just-used sandbox counts as measurably idle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeAll(() => ensureSchema());
afterAll(async () => {
  await sandboxService.destroy(WS);
});

test("acquire creates a workspace and a running container", async () => {
  const sandbox = await sandboxService.acquire(WS);
  expect(fs.existsSync(sandbox.workspacePath)).toBe(true);
  expect(await isRunning(sandbox.containerId)).toBe(true);
});

test("acquire reuses a warm container", async () => {
  const first = await sandboxService.acquire(WS);
  const second = await sandboxService.acquire(WS);
  expect(second.containerId).toBe(first.containerId);
});

test("the workspace survives destroying the container", async () => {
  const sandbox = await sandboxService.acquire(WS);
  fs.writeFileSync(path.join(sandbox.workspacePath, "keep.txt"), "kept");

  await sandboxService.destroy(WS);
  expect(fs.existsSync(path.join(sandbox.workspacePath, "keep.txt"))).toBe(true);

  const again = await sandboxService.acquire(WS);
  expect(again.containerId).not.toBe(sandbox.containerId);
  expect(fs.readFileSync(path.join(again.workspacePath, "keep.txt"), "utf8")).toBe("kept");
});

test("reapIdle removes containers past the idle window", async () => {
  await sandboxService.acquire(WS);
  await sandboxService.release(WS);
  await tick();

  const reaped = await sandboxService.reapIdle(0);
  expect(reaped).toBeGreaterThan(0);
  expect((await sandboxRepository.get(WS))?.containerId).toBeNull();
});

test("reapIdle leaves warm containers alone", async () => {
  const sandbox = await sandboxService.acquire(WS);
  const reaped = await sandboxService.reapIdle(60_000);
  expect(reaped).toBe(0);
  expect(await isRunning(sandbox.containerId)).toBe(true);
});
