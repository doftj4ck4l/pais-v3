import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../../config/env";
import { ensureSchema } from "../../db/client";
import type { ExecResult, SandboxApi, StatInfo } from "../sandbox/pixelbox-client";
import { PixelboxError } from "../sandbox/pixelbox-client";
import { setSandboxApiForTests } from "../sandbox/sandbox.service";
import { listWorkspaceFiles, readInWorkspace, statInWorkspace, writeWorkspaceFile } from "./workspace-io";

const original = env.sandboxBackend;
const originalRoot = env.sandboxRoot;
const setBackend = (b: "node" | "pixelbox") => {
  (env as { sandboxBackend: string }).sandboxBackend = b;
};

/** Fake sandbox: absolute-path keyed files, plus a `find` responder for exec. */
function fakeApi(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const api: SandboxApi = {
    async create() {
      return { sandboxId: "sb-io", state: "ready" };
    },
    async get() {
      return { sandboxId: "sb-io", state: "ready" };
    },
    async delete() {},
    async execute(_id, req): Promise<ExecResult> {
      // Emulate the `find ... -printf '%P\t%s\t%T@\n'` used by listWorkspaceFiles.
      const lines: string[] = [];
      for (const [p, v] of files) {
        const rel = p.replace("/workspace/", "");
        if (rel.split("/").some((s) => s.startsWith("."))) continue; // -not -path '*/.*'
        lines.push(`${rel}\t${v.length}\t1700000000.0`);
      }
      return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0, timedOut: false };
    },
    async readBytes(_id, p) {
      const v = files.get(p);
      if (v === undefined) throw new PixelboxError("NOT_FOUND", `missing ${p}`, 404);
      return new TextEncoder().encode(v);
    },
    async writeBytes(_id, p, content) {
      files.set(p, new TextDecoder().decode(content));
    },
    async stat(_id, p): Promise<StatInfo | null> {
      return files.has(p) ? { kind: "file", size: files.get(p)!.length, mtimeMs: 5 } : null;
    },
    async list() {
      return [];
    },
    async createDir() {},
    async remove() {},
  };
  return api;
}

beforeAll(() => ensureSchema());
afterAll(() => {
  setBackend(original as "node" | "pixelbox");
  (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
});
beforeEach(() => setSandboxApiForTests(fakeApi()));

test("node backend reads a file from the host path", async () => {
  setBackend("node");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "host-bytes");
  const bytes = await readInWorkspace("ws1", path.join(dir, "a.txt"));
  expect(bytes && new TextDecoder().decode(bytes)).toBe("host-bytes");
  const stat = await statInWorkspace("ws1", path.join(dir, "a.txt"));
  expect(stat?.isFile).toBe(true);
});

test("pixelbox backend reads a file through the sandbox API", async () => {
  setBackend("pixelbox");
  setSandboxApiForTests(fakeApi({ "/workspace/chart.png": "PNGDATA" }));
  const bytes = await readInWorkspace("ws1", "/workspace/chart.png");
  expect(bytes && new TextDecoder().decode(bytes)).toBe("PNGDATA");
  const stat = await statInWorkspace("ws1", "/workspace/chart.png");
  expect(stat).toEqual({ size: 7, mtimeMs: 5, isFile: true });
});

test("pixelbox missing file returns null, not a throw", async () => {
  setBackend("pixelbox");
  setSandboxApiForTests(fakeApi());
  expect(await readInWorkspace("ws1", "/workspace/nope")).toBeNull();
  expect(await statInWorkspace("ws1", "/workspace/nope")).toBeNull();
});

test("pixelbox list excludes dot-dirs and returns newest-first relatives", async () => {
  setBackend("pixelbox");
  setSandboxApiForTests(
    fakeApi({
      "/workspace/chart.png": "img",
      "/workspace/.local/lib/numpy.py": "pkg",
      "/workspace/notes.txt": "hi",
    }),
  );
  const files = await listWorkspaceFiles("ws1");
  const paths = files.map((f) => f.path);
  expect(paths).toContain("chart.png");
  expect(paths).toContain("notes.txt");
  expect(paths).not.toContain(".local/lib/numpy.py");
});

test("pixelbox writes relative workspace files through the sandbox API", async () => {
  setBackend("pixelbox");
  const api = fakeApi();
  setSandboxApiForTests(api);

  await writeWorkspaceFile("ws1", "uploads/run/data.csv", new TextEncoder().encode("a,b\n1,2"));

  const bytes = await api.readBytes("sb-io", "/workspace/uploads/run/data.csv");
  expect(new TextDecoder().decode(bytes)).toBe("a,b\n1,2");
});

test("pixelbox writes root workspace files without recreating the existing root", async () => {
  setBackend("pixelbox");
  const api = fakeApi();
  api.createDir = async (_id, directory) => {
    if (directory === "/workspace") throw new Error(`unexpected mkdir ${directory}`);
  };
  setSandboxApiForTests(api);

  await writeWorkspaceFile("ws1", "upload-data.csv", new TextEncoder().encode("a,b\n1,2"));

  const bytes = await api.readBytes("sb-io", "/workspace/upload-data.csv");
  expect(new TextDecoder().decode(bytes)).toBe("a,b\n1,2");
});

test("workspace writes reject traversal before touching either backend", async () => {
  setBackend("pixelbox");
  await expect(writeWorkspaceFile("ws1", "../outside.csv", new Uint8Array([1]))).rejects.toThrow(
    "invalid workspace path",
  );
});

test("node workspace writes reject a symlinked upload directory", async () => {
  setBackend("node");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-outside-"));
  (env as { sandboxRoot: string }).sandboxRoot = root;
  fs.mkdirSync(path.join(root, "ws1"));
  fs.symlinkSync(outside, path.join(root, "ws1", "uploads"), "dir");

  try {
    await expect(
      writeWorkspaceFile("ws1", "uploads/run/data.csv", new Uint8Array([1])),
    ).rejects.toThrow("invalid workspace path");
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
  }
});
