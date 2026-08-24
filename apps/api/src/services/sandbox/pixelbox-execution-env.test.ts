import { describe, expect, test } from "bun:test";
import { PixelboxExecutionEnv } from "./pixelbox-execution-env";
import { PYTHON_RUNTIME_ENV } from "./python-baseline";
import {
  PixelboxError,
  type ExecRequest,
  type ExecResult,
  type ListEntry,
  type SandboxApi,
  type StatInfo,
} from "./pixelbox-client";

/**
 * An in-memory Sandbox API. Files live in a map keyed by absolute path so the
 * execution env's own path resolution (relative -> /workspace) is what is under
 * test, not a real service.
 */
function fakeApi(seed: Record<string, string> = {}): SandboxApi & {
  files: Map<string, Uint8Array>;
  lastExec?: ExecRequest;
} {
  const files = new Map<string, Uint8Array>();
  for (const [p, v] of Object.entries(seed)) files.set(p, new TextEncoder().encode(v));
  const api: any = {
    files,
    async create() {
      return { sandboxId: "sb-fake", state: "ready" };
    },
    async get() {
      return { sandboxId: "sb-fake", state: "ready" };
    },
    async delete() {},
    async execute(_id: string, req: ExecRequest): Promise<ExecResult> {
      api.lastExec = req;
      return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false };
    },
    async readBytes(_id: string, path: string): Promise<Uint8Array> {
      const b = files.get(path);
      if (!b) throw new PixelboxError("NOT_FOUND", `missing ${path}`, 404);
      return b;
    },
    async writeBytes(_id: string, path: string, content: Uint8Array) {
      files.set(path, content);
    },
    async stat(_id: string, path: string): Promise<StatInfo | null> {
      if (files.has(path)) return { kind: "file", size: files.get(path)!.length, mtimeMs: 111 };
      // treat any path that is a prefix of a stored file as a directory
      for (const key of files.keys()) if (key.startsWith(path + "/")) return { kind: "dir", size: 0, mtimeMs: 222 };
      return null;
    },
    async list(_id: string, path: string): Promise<ListEntry[]> {
      const out: ListEntry[] = [];
      for (const [key, val] of files) {
        if (key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/")) {
          out.push({ name: key.slice(path.length + 1), path: key, kind: "file", size: val.length, mtimeMs: 111 });
        }
      }
      return out;
    },
    async createDir() {},
    async remove(_id: string, path: string) {
      files.delete(path);
    },
  };
  return api;
}

const env = (api: SandboxApi) => new PixelboxExecutionEnv({ api, sandboxId: "sb-fake", cwd: "/workspace" });

describe("PixelboxExecutionEnv shell", () => {
  test("exec returns stdout/stderr/exitCode on success", async () => {
    const result = await env(fakeApi()).exec("echo hi");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stdout).toBe("ok\n");
  });

  test("exec resolves relative cwd against /workspace", async () => {
    const api = fakeApi();
    await env(api).exec("ls", { cwd: "sub" });
    expect(api.lastExec?.cwd).toBe("/workspace/sub");
  });

  test("exec includes the Python runtime environment defaults", async () => {
    const api = fakeApi();
    await env(api).exec("python3 -c 'import pandas'");
    expect(api.lastExec?.env).toEqual(PYTHON_RUNTIME_ENV);
  });

  test("exec lets callers override Python defaults without dropping the rest", async () => {
    const api = fakeApi();
    await env(api).exec("env", { env: { HOME: "/tmp/custom-home", EXTRA: "yes" } });
    expect(api.lastExec?.env).toEqual({
      ...PYTHON_RUNTIME_ENV,
      HOME: "/tmp/custom-home",
      EXTRA: "yes",
    });
  });

  test("exec maps a timed-out result to a timeout ExecutionError", async () => {
    const api = fakeApi();
    (api as any).execute = async () => ({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
    const result = await env(api).exec("sleep 999", { timeout: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });

  test("exec on an already-aborted signal returns aborted without calling the API", async () => {
    const api = fakeApi();
    let called = false;
    (api as any).execute = async () => {
      called = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const controller = new AbortController();
    controller.abort();
    const result = await env(api).exec("echo hi", { abortSignal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
    expect(called).toBe(false);
  });
});

describe("PixelboxExecutionEnv filesystem", () => {
  test("readTextFile reads a relative path under the workspace", async () => {
    const result = await env(fakeApi({ "/workspace/a.txt": "hello" })).readTextFile("a.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
  });

  test("readTextFile on a missing file returns a not_found FileError", async () => {
    const result = await env(fakeApi()).readTextFile("nope.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  test("writeFile then readTextFile round-trips", async () => {
    const e = env(fakeApi());
    await e.writeFile("out.txt", "written");
    const result = await e.readTextFile("out.txt");
    expect(result.ok && result.value).toBe("written");
  });

  test("exists is false for a missing path and true for a present one", async () => {
    const e = env(fakeApi({ "/workspace/here.txt": "x" }));
    const present = await e.exists("here.txt");
    expect(present.ok && present.value).toBe(true);
    const missing = await e.exists("gone.txt");
    expect(missing.ok && missing.value).toBe(false);
  });

  test("fileInfo maps the service 'dir' kind to Pi 'directory'", async () => {
    const api = fakeApi({ "/workspace/d/child": "x" });
    const result = await env(api).fileInfo("d");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("directory");
  });

  test("appendFile concatenates onto existing content", async () => {
    const e = env(fakeApi({ "/workspace/log.txt": "a" }));
    await e.appendFile("log.txt", "b");
    const result = await e.readTextFile("log.txt");
    expect(result.ok && result.value).toBe("ab");
  });

  test("absolutePath resolves a relative path against the workspace without a remote call", async () => {
    const result = await env(fakeApi()).absolutePath("x/y.txt");
    expect(result.ok && result.value).toBe("/workspace/x/y.txt");
  });
});

describe("PixelboxExecutionEnv cleanup", () => {
  test("cleanup never rejects even when the API throws", async () => {
    const api = fakeApi();
    (api as any).delete = async () => {
      throw new Error("boom");
    };
    // Owned session -> cleanup deletes; a throw must be swallowed.
    const e = new PixelboxExecutionEnv({ api, sandboxId: "sb-fake", cwd: "/workspace", ownsSandbox: true });
    await expect(e.cleanup()).resolves.toBeUndefined();
  });
});
