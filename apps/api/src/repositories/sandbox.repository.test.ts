import { expect, test, beforeAll } from "bun:test";
import { ensureSchema } from "../db/client";
import { sandboxRepository } from "./sandbox.repository";

const USER = `test_${Date.now()}`;

beforeAll(() => ensureSchema());

test("upsert then get returns the row", async () => {
  await sandboxRepository.upsert({
    userId: USER,
    containerId: "c1",
    workspacePath: "/tmp/ws",
    image: "img",
  });
  const row = await sandboxRepository.get(USER);
  expect(row?.containerId).toBe("c1");
  expect(row?.workspacePath).toBe("/tmp/ws");
});

test("upsert replaces the container for the same user", async () => {
  await sandboxRepository.upsert({
    userId: USER,
    containerId: "c2",
    workspacePath: "/tmp/ws",
    image: "img",
  });
  const row = await sandboxRepository.get(USER);
  expect(row?.containerId).toBe("c2");
});

test("clearContainer nulls the container but keeps the workspace", async () => {
  await sandboxRepository.clearContainer(USER);
  const row = await sandboxRepository.get(USER);
  expect(row?.containerId).toBeNull();
  expect(row?.workspacePath).toBe("/tmp/ws");
});

test("listIdle finds rows untouched for longer than the window", async () => {
  await sandboxRepository.upsert({
    userId: USER,
    containerId: "c3",
    workspacePath: "/tmp/ws",
    image: "img",
  });
  const stale = await sandboxRepository.listIdle(0);
  expect(stale.some((r) => r.userId === USER)).toBe(true);

  const fresh = await sandboxRepository.listIdle(60_000);
  expect(fresh.some((r) => r.userId === USER)).toBe(false);
});

test("listIdle ignores rows with no container", async () => {
  await sandboxRepository.clearContainer(USER);
  const stale = await sandboxRepository.listIdle(0);
  expect(stale.some((r) => r.userId === USER)).toBe(false);
});

test("get returns undefined for an unknown user", async () => {
  expect(await sandboxRepository.get("nobody-at-all")).toBeUndefined();
});
