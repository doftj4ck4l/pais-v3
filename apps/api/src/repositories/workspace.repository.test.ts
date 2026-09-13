import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../config/env";
import { list, resolve } from "./workspace.repository";

/**
 * These run against a real temporary directory rather than a mocked filesystem:
 * the guard exists to defeat symlinks and traversal, and neither behaves
 * realistically when faked.
 */
let root: string;
const original = env.sandboxRoot;
const WS = "ws1";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
  // `env` is a const object; the sandbox root is swapped for the duration.
  (env as { sandboxRoot: string }).sandboxRoot = root;
  fs.mkdirSync(path.join(root, WS), { recursive: true });
});

afterEach(() => {
  (env as { sandboxRoot: string }).sandboxRoot = original;
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, body = "x") => {
  const full = path.join(root, WS, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

describe("resolve", () => {
  it("accepts a file in the workspace", async () => {
    const full = write("report.xlsx");
    const out = await resolve(WS, "report.xlsx");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.absolutePath).toBe(fs.realpathSync(full));
  });

  it("accepts a nested file", async () => {
    write("out/2026/report.xlsx");
    expect((await resolve(WS, "out/2026/report.xlsx")).ok).toBe(true);
  });

  it("rejects traversal out of the workspace", async () => {
    fs.writeFileSync(path.join(root, "secret.txt"), "s");
    for (const p of ["../secret.txt", "../../etc/passwd", "out/../../secret.txt"]) {
      expect((await resolve(WS, p)).ok).toBe(false);
    }
  });

  it("rejects absolute paths", async () => {
    expect((await resolve(WS, "/etc/passwd")).ok).toBe(false);
    expect((await resolve(WS, path.join(root, "secret.txt"))).ok).toBe(false);
  });

  it("rejects a symlink escaping the workspace", async () => {
    // The agent can create links inside its own workspace, so a purely textual
    // check would pass this.
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(root, WS, "link.txt"));
    expect((await resolve(WS, "link.txt")).ok).toBe(false);
  });

  it("allows a symlink that stays inside the workspace", async () => {
    write("real.txt");
    fs.symlinkSync(path.join(root, WS, "real.txt"), path.join(root, WS, "alias.txt"));
    expect((await resolve(WS, "alias.txt")).ok).toBe(true);
  });

  it("rejects directories and missing files identically", async () => {
    fs.mkdirSync(path.join(root, WS, "adir"));
    expect((await resolve(WS, "adir")).ok).toBe(false);
    expect((await resolve(WS, "nope.txt")).ok).toBe(false);
  });

  it("rejects empty and dot paths", async () => {
    for (const p of ["", ".", "..", "./", "//"]) {
      expect((await resolve(WS, p)).ok).toBe(false);
    }
  });

  it("keeps users apart", async () => {
    write("mine.txt");
    expect((await resolve("u2", "mine.txt")).ok).toBe(false);
  });
});

describe("list", () => {
  it("lists files newest first with relative paths", async () => {
    write("a.txt");
    write("nested/b.txt");
    const files = await list(WS);
    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "nested/b.txt"]);
    expect(files[0]!.modifiedAt).toBeGreaterThanOrEqual(files[1]!.modifiedAt);
    expect(files.every((f) => f.bytes > 0)).toBe(true);
  });

  it("does not follow symlinks out of the workspace", async () => {
    write("real.txt");
    fs.writeFileSync(path.join(root, "outside.txt"), "s");
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(root, WS, "link.txt"));
    const files = await list(WS);
    expect(files.map((f) => f.path)).toEqual(["real.txt"]);
  });

  it("keeps application-owned files out of the agent output browser", async () => {
    write("report.txt");
    write(".pixelspace/transcriptions/trx_demo.mp3");
    expect((await list(WS)).map((file) => file.path)).toEqual(["report.txt"]);
  });

  it("returns nothing for a user with no workspace", async () => {
    expect(await list("never-seen")).toEqual([]);
  });
});
