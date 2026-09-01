import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ensureSchema } from "../../db/client";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import { isRunning } from "./docker";
import { sandboxService } from "./sandbox.service";
import { env as appEnv } from "../../config/env";

const WS = `sbx_ws_${Date.now()}`;
const CONCURRENT_WS = `${WS}_concurrent`;
const MIGRATED_WS = `${WS}_migrated`;
const LEASED_WS = `${WS}_leased`;

/** Let the clock advance so a just-used sandbox counts as measurably idle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeAll(() => ensureSchema());
afterAll(async () => {
  await sandboxService.destroy(WS);
  await sandboxService.destroy(CONCURRENT_WS);
  await sandboxService.destroy(MIGRATED_WS);
  await sandboxService.destroy(LEASED_WS);
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

test("concurrent cold acquires converge on one container", async () => {
  const [first, second] = await Promise.all([
    sandboxService.acquire(CONCURRENT_WS),
    sandboxService.acquire(CONCURRENT_WS),
  ]);
  expect(second.containerId).toBe(first.containerId);
  expect(await isRunning(first.containerId)).toBe(true);
});

test("a retained Pixelbox row migrates to the Docker workspace root", async () => {
  await sandboxRepository.upsert({
    workspaceId: MIGRATED_WS,
    containerId: "sb-retained-pixelbox-id",
    workspacePath: "/workspace",
    image: "pixelbox",
  });

  const sandbox = await sandboxService.acquire(MIGRATED_WS);
  expect(sandbox.workspacePath).toBe(path.join(appEnv.sandboxRoot, MIGRATED_WS));
  expect((await sandboxRepository.get(MIGRATED_WS))?.workspacePath).toBe(sandbox.workspacePath);
  expect(await isRunning(sandbox.containerId)).toBe(true);
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

test("reapIdle cannot remove a container leased by an active run", async () => {
  const lease = await sandboxService.acquireLease(LEASED_WS);
  await tick();
  await sandboxService.reapIdle(0);
  expect(await isRunning(lease.containerId)).toBe(true);

  await lease.release();
  await tick();
  expect(await sandboxService.reapIdle(0)).toBeGreaterThan(0);
  expect((await sandboxRepository.get(LEASED_WS))?.containerId).toBeNull();
});
