import { expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureImage, removeContainer, runDetached } from "./docker";
import { DockerExecutionEnv } from "./docker-execution-env";
import { env as appEnv } from "../../config/env";

const IMAGE = appEnv.sandboxImage;
const WS = path.join(os.homedir(), "pixelspace-workspaces", "test-env");
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

test("host uploads are visible inside the container", async () => {
  fs.writeFileSync(path.join(WS, "host-upload.csv"), "name,value\nalpha,1\n");
  const r = await env.readTextFile(path.join(WS, "host-upload.csv"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value).toBe("name,value\nalpha,1\n");
});

test("container writes are visible to the filesystem methods", async () => {
  await env.exec("echo from-container > made-in-container.txt");
  const r = await env.readTextFile(path.join(WS, "made-in-container.txt"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.trim()).toBe("from-container");
});

test("container outputs are visible to the API host", async () => {
  const r = await env.exec("printf report-ready > generated-report.txt");
  expect(r.ok).toBe(true);
  expect(fs.readFileSync(path.join(WS, "generated-report.txt"), "utf8")).toBe("report-ready");
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

test("sandbox symlinks cannot make host filesystem methods escape", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-host-secret-"));
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "host-secret");
  fs.symlinkSync(secret, path.join(WS, "host-secret-link"));
  fs.symlinkSync(outside, path.join(WS, "host-dir-link"));

  try {
    const read = await env.readTextFile(path.join(WS, "host-secret-link"));
    expect(read.ok).toBe(false);

    const write = await env.writeFile(path.join(WS, "host-dir-link", "created.txt"), "escaped");
    expect(write.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, "created.txt"))).toBe(false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
