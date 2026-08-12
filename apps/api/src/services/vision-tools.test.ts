import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVisionTools, generatedImageId, resolveInWorkspace } from "./vision-tools";
import type { ImageStore } from "../repositories/image.repository";

describe("resolveInWorkspace", () => {
  const root = "/srv/workspaces/ws1";

  it("resolves a relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "shot.png")).toBe("/srv/workspaces/ws1/shot.png");
    expect(resolveInWorkspace(root, "sub/dir/shot.png")).toBe("/srv/workspaces/ws1/sub/dir/shot.png");
  });

  it("accepts an absolute path that is already inside", () => {
    expect(resolveInWorkspace(root, "/srv/workspaces/ws1/a.png")).toBe("/srv/workspaces/ws1/a.png");
  });

  it("refuses traversal out of the workspace", () => {
    // This tool runs with the API's privileges and SANDBOX_ROOT is mounted into
    // the API container, so an unchecked `..` reads the API's own secrets and
    // posts them to a model.
    expect(resolveInWorkspace(root, "../../../etc/passwd")).toBeNull();
    expect(resolveInWorkspace(root, "/etc/passwd")).toBeNull();
    expect(resolveInWorkspace(root, "sub/../../../secrets.env")).toBeNull();
  });

  it("refuses a sibling directory sharing the workspace's name prefix", () => {
    // A plain startsWith check passes `/srv/workspaces/ws1-backup`, which is a
    // different workspace.
    expect(resolveInWorkspace(root, "/srv/workspaces/ws1-backup/a.png")).toBeNull();
  });
});

describe("generatedImageId", () => {
  it("accepts the URL generate_image returns, and a bare id", () => {
    expect(generatedImageId("/api/images/img_abc123")).toBe("img_abc123");
    expect(generatedImageId("img_abc123")).toBe("img_abc123");
  });

  it("is not fooled by a path that merely mentions images", () => {
    expect(generatedImageId("screenshot.png")).toBeNull();
    expect(generatedImageId("/api/images/../../etc/passwd")).toBeNull();
    expect(generatedImageId("img_abc/../x")).toBeNull();
  });
});

describe("read_image", () => {
  let dir: string;
  const store = {
    get: async (id: string) =>
      id === "img_other"
        ? ({ id, workspaceId: "ws_other", storageKey: "k", contentType: "image/png" } as any)
        : undefined,
  } as unknown as ImageStore;

  const tool = () => createVisionTools("ws1", dir, store)[0]!;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const output = (r: any) => r.content[0].text as string;

  it("requires a question, since the question is the only control", async () => {
    expect(output(await tool().execute("1", { source: "a.png" }))).toContain("question required");
  });

  it("requires a source", async () => {
    expect(output(await tool().execute("1", { question: "what?" }))).toContain("source required");
  });

  it("refuses a path outside the workspace before touching the disk", async () => {
    const out = output(await tool().execute("1", { source: "/etc/passwd", question: "what?" }));
    expect(out).toContain("outside your workspace");
  });

  it("refuses a file that is not an image, naming what it accepts", async () => {
    const out = output(await tool().execute("1", { source: "notes.txt", question: "what?" }));
    expect(out).toContain("not a readable image");
    expect(out).toContain(".png");
  });

  it("reports a missing file as missing rather than as a failure", async () => {
    const out = output(await tool().execute("1", { source: "gone.png", question: "what?" }));
    expect(out).toContain("does not exist");
  });

  it("will not read another workspace's generated image", async () => {
    const out = output(await tool().execute("1", { source: "/api/images/img_other", question: "what?" }));
    expect(out).toContain("no generated image");
  });
});
