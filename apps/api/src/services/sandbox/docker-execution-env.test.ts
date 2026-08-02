import { expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureImage, removeContainer, runDetached } from "./docker";
import { DockerExecutionEnv } from "./docker-execution-env";

const IMAGE = "node:22-bookworm-slim";
const WS = path.join(os.homedir(), "mixmatch-workspaces", "test-env");
let id = "";
let env: DockerExecutionEnv;

beforeAll(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  await ensureImage(IMAGE);
  id = await runDetached({ image: IMAGE, workspacePath: WS, name: `mm-env-${Date.now()}` });
  env = new DockerExecutionEnv({ containerId: id, cwd: WS });
});

afterAll(async () => {
  await env?.cleanup();
  if (id) await removeContainer(id);
  fs.rmSync(WS, { recursive: true, force: true });
});

test("exec runs inside the container", async () => {
  const r = await env.exec("echo hello");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.stdout.trim()).toBe("hello");
  expect(r.value.exitCode).toBe(0);
});

test("a failed command is ok:true with a non-zero exit code", async () => {
  const r = await env.exec("exit 7");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.exitCode).toBe(7);
});

test("timeout returns err with code 'timeout'", async () => {
  const r = await env.exec("sleep 5", { timeout: 0.3 });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("timeout");
});

test("abort returns err with code 'aborted'", async () => {
  const controller = new AbortController();
  const pending = env.exec("sleep 5", { abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const r = await pending;
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("aborted");
});

test("filesystem writes are visible to the container", async () => {
  const written = await env.writeFile(path.join(WS, "from-env.txt"), "written");
  expect(written.ok).toBe(true);
  const r = await env.exec("cat from-env.txt");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.stdout.trim()).toBe("written");
});

test("container writes are visible to the filesystem methods", async () => {
  await env.exec("echo from-container > made-in-container.txt");
  const r = await env.readTextFile(path.join(WS, "made-in-container.txt"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.trim()).toBe("from-container");
});

test("listDir sees files made on both sides", async () => {
  const r = await env.listDir(WS);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const names = r.value.map((e: { name: string }) => e.name);
  expect(names).toContain("from-env.txt");
  expect(names).toContain("made-in-container.txt");
});

test("cwd is the workspace path", () => {
  expect(env.cwd).toBe(WS);
});
