import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../../config/env";
import { readInWorkspace, statInWorkspace, writeWorkspaceFile } from "./workspace-io";

const originalRoot = env.sandboxRoot;

afterAll(() => {
  (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
});

test("reads a workspace file from the host path shared with Docker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsio-"));
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "host-bytes");
    const bytes = await readInWorkspace("ws1", path.join(dir, "a.txt"));
    expect(bytes && new TextDecoder().decode(bytes)).toBe("host-bytes");
    const stat = await statInWorkspace("ws1", path.join(dir, "a.txt"));
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
