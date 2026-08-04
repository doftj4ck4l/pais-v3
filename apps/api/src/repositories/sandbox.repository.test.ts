import { expect, test, beforeAll } from "bun:test";
import { ensureSchema } from "../db/client";
import { sandboxRepository } from "./sandbox.repository";

const WS = `ws_test_${Date.now()}`;

/** Let the clock advance so a just-written row counts as measurably idle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeAll(() => ensureSchema());

test("upsert then get returns the row", async () => {
  await sandboxRepository.upsert({
    workspaceId: WS,
    containerId: "c1",
    workspacePath: "/tmp/ws",
    image: "img",
  });
  const row = await sandboxRepository.get(WS);
  expect(row?.containerId).toBe("c1");
  expect(row?.workspacePath).toBe("/tmp/ws");
});

test("upsert replaces the container for the same workspace", async () => {
  await sandboxRepository.upsert({
    workspaceId: WS,
    containerId: "c2",
    workspacePath: "/tmp/ws",
    image: "img",
  });
  const row = await sandboxRepository.get(WS);
  expect(row?.containerId).toBe("c2");
});

test("clearContainer nulls the container but keeps the workspace", async () => {
  await sandboxRepository.clearContainer(WS);
  const row = await sandboxRepository.get(WS);
  expect(row?.containerId).toBeNull();
  expect(row?.workspacePath).toBe("/tmp/ws");
});

test("listIdle finds rows untouched for longer than the window", async () => {
  await sandboxRepository.upsert({
    workspaceId: WS,
    containerId: "c3",
    workspacePath: "/tmp/ws",
    image: "img",
  });
  await tick();
  const stale = await sandboxRepository.listIdle(0);
  expect(stale.some((r) => r.workspaceId === WS)).toBe(true);

  const fresh = await sandboxRepository.listIdle(60_000);
  expect(fresh.some((r) => r.workspaceId === WS)).toBe(false);
});

test("listIdle ignores rows with no container", async () => {
  await sandboxRepository.clearContainer(WS);
  await tick();
  const stale = await sandboxRepository.listIdle(0);
  expect(stale.some((r) => r.workspaceId === WS)).toBe(false);
});

test("get returns undefined for an unknown user", async () => {
  expect(await sandboxRepository.get("nobody-at-all")).toBeUndefined();
});
