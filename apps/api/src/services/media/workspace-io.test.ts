import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../../config/env";
import { ok } from "@earendil-works/pi-agent-core";
import { readInWorkspace, statInWorkspace, writeWorkspaceFile } from "./workspace-io";

const originalRoot = env.sandboxRoot;
const originalBackend = env.sandboxBackend;

afterAll(() => {
  (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
  (env as { sandboxBackend: "node" | "docker" }).sandboxBackend = originalBackend;
});

test("reads a workspace file from the host path shared with Docker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-"));
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "host-bytes");
    const openWorkspace: any = async () => ({
      readBinaryFile: async (file: string) => ok(new Uint8Array(fs.readFileSync(file))),
      fileInfo: async (file: string) => {
        const stat = fs.statSync(file);
        return ok({
          name: path.basename(file),
          path: file,
          kind: stat.isFile() ? "file" as const : "directory" as const,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      },
    });
    const bytes = await readInWorkspace("ws1", path.join(dir, "a.txt"), openWorkspace);
    expect(bytes && new TextDecoder().decode(bytes)).toBe("host-bytes");
    const stat = await statInWorkspace("ws1", path.join(dir, "a.txt"), openWorkspace);
    expect(stat?.isFile).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writes a root workspace upload to the shared host directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-root-"));
  (env as { sandboxRoot: string }).sandboxRoot = root;
  try {
    await writeWorkspaceFile("ws1", "upload-data.csv", new TextEncoder().encode("a,b\n1,2"));
    expect(fs.readFileSync(path.join(root, "ws1", "upload-data.csv"), "utf8")).toBe("a,b\n1,2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
  }
});

test("node backend reads stay host-local without acquiring Docker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-node-"));
  (env as { sandboxRoot: string }).sandboxRoot = root;
  (env as { sandboxBackend: "node" | "docker" }).sandboxBackend = "node";
  fs.mkdirSync(path.join(root, "ws1"));
  const file = path.join(root, "ws1", "local.txt");
  fs.writeFileSync(file, "local-only");

  try {
    const bytes = await readInWorkspace("ws1", file);
    expect(bytes && new TextDecoder().decode(bytes)).toBe("local-only");
    expect((await statInWorkspace("ws1", file))?.isFile).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
    (env as { sandboxBackend: "node" | "docker" }).sandboxBackend = originalBackend;
  }
});

test("workspace writes reject traversal", async () => {
  await expect(writeWorkspaceFile("ws1", "../outside.csv", new Uint8Array([1]))).rejects.toThrow(
    "invalid workspace path",
  );
});

test("workspace writes reject a symlinked upload directory", async () => {
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
