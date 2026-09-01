import { expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dockerAvailable,
  ensureImage,
  execInContainer,
  isRunning,
  removeContainer,
  runDetached,
} from "./docker";

const IMAGE = "node:22-bookworm-slim";
const WS = path.join(os.homedir(), "pixelspace-workspaces", "test-docker");
let id = "";

beforeAll(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  await ensureImage(IMAGE);
  id = await runDetached({ image: IMAGE, workspacePath: WS, name: `mm-test-${Date.now()}` });
});

afterAll(async () => {
  if (id) await removeContainer(id);
  fs.rmSync(WS, { recursive: true, force: true });
});

test("daemon is available", async () => {
  expect(await dockerAvailable()).toBe(true);
});

test("container is running", async () => {
  expect(await isRunning(id)).toBe(true);
});

test("exec captures stdout, stderr and exit code separately", async () => {
  const r = await execInContainer(id, "echo out; echo err >&2; exit 3");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.result.stdout.trim()).toBe("out");
  expect(r.result.stderr.trim()).toBe("err");
  expect(r.result.exitCode).toBe(3);
});

test("exec runs in the workspace by default", async () => {
  const r = await execInContainer(id, "pwd");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.result.stdout.trim()).toBe(WS);
});

test("exec honours a timeout", async () => {
  const r = await execInContainer(id, "sleep 5", { timeoutMs: 300 });
  expect(r.kind).toBe("timeout");
});

test("exec honours an abort signal", async () => {
  const controller = new AbortController();
  const pending = execInContainer(id, "sleep 5", { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  expect((await pending).kind).toBe("aborted");
});

test("exec streams stdout chunks", async () => {
  const chunks: string[] = [];
  await execInContainer(id, "echo streamed", { onStdout: (c) => chunks.push(c) });
  expect(chunks.join("")).toContain("streamed");
});

test("exec passes environment variables through", async () => {
  const r = await execInContainer(id, "echo $MIXMATCH_TEST", { env: { MIXMATCH_TEST: "passed" } });
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.result.stdout.trim()).toBe("passed");
});

test("isRunning is false for an unknown container", async () => {
  expect(await isRunning("does-not-exist-xyz")).toBe(false);
});
