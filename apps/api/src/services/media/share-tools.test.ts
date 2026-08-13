import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createShareTools, workspaceFileUrl } from "./share-tools";
import type { UploadResult } from "./upload.service";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "share-tools-"));
  fs.writeFileSync(path.join(root, "report.xlsx"), "sheet");
  fs.writeFileSync(path.join(root, "panda.png"), "not really a png");
  fs.writeFileSync(path.join(root, "panda.svg"), "<svg/>");
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out", "a b.txt"), "spaces");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** The tool's text payload, which is all the model ever sees. */
const out = (result: any): string => result.content[0].text as string;

const withBucket = (uploads: any[] = []) => ({
  configured: () => true,
  store: async (input: any): Promise<UploadResult> => {
    uploads.push(input);
    return {
      ok: true,
      id: "3f9a1c2e-7b41-4d0a-9c33-2e8b17d5a604",
      url: "/api/images/3f9a1c2e-7b41-4d0a-9c33-2e8b17d5a604",
      contentType: input.contentType,
      bytes: input.bytes.byteLength,
      name: input.name,
    };
  },
});

const noBucket = {
  configured: () => false,
  store: async (): Promise<UploadResult> => {
    throw new Error("must not be called when the bucket is unconfigured");
  },
};

const share = (deps: any) => createShareTools("ws1", root, deps)[0];

describe("workspaceFileUrl", () => {
  it("names the workspace, so a second workspace cannot shadow the file", () => {
    expect(workspaceFileUrl("ws1", "report.xlsx")).toBe(
      "/api/workspace/files/report.xlsx?workspaceId=ws1",
    );
  });

  it("encodes each segment separately — the route splits on / before decoding", () => {
    expect(workspaceFileUrl("ws1", path.join("out", "a b.txt"))).toBe(
      "/api/workspace/files/out/a%20b.txt?workspaceId=ws1",
    );
  });
});

describe("share_file", () => {
  it("puts an image in the bucket and returns a URL to embed", async () => {
    const uploads: any[] = [];
    const result = out(await share(withBucket(uploads)).execute("c1", { path: "panda.png" }));

    expect(uploads).toHaveLength(1);
    expect(uploads[0].contentType).toBe("image/png");
    // Not "uploaded": a file the agent drew is not something the user sent, and
    // the column is what keeps a cost report honest.
    expect(uploads[0].source).toBe("shared");
    expect(result).toContain("/api/images/3f9a1c2e-7b41-4d0a-9c33-2e8b17d5a604");
    expect(result).toContain("![panda.png](");
  });

  it("gives a non-image its workspace download link", async () => {
    const result = out(await share(noBucket).execute("c1", { path: "report.xlsx" }));
    expect(result).toContain("/api/workspace/files/report.xlsx?workspaceId=ws1");
  });

  it("treats SVG as a document, not an image", async () => {
    // It can carry script and the bucket route serves from the console's own
    // origin; the file route serves every extension as an attachment.
    const uploads: any[] = [];
    const result = out(await share(withBucket(uploads)).execute("c1", { path: "panda.svg" }));
    expect(uploads).toHaveLength(0);
    expect(result).toContain("/api/workspace/files/panda.svg");
  });

  it("falls back to the download link when the bucket is unreachable", async () => {
    // The file is still there. A bucket outage should cost a thumbnail, not the
    // answer the run already produced.
    const result = out(
      await share({
        configured: () => true,
        store: async (): Promise<UploadResult> => ({ ok: false, error: "connection refused" }),
      }).execute("c1", { path: "panda.png" }),
    );
    expect(result).toContain("/api/workspace/files/panda.png?workspaceId=ws1");
  });

  it("refuses a path outside the workspace", async () => {
    // This tool runs with the API's privileges and SANDBOX_ROOT is mounted into
    // the API container, so an unchecked `..` would publish the API's secrets
    // at a URL anyone with the link could fetch.
    for (const bad of ["../../etc/passwd", "/etc/passwd", "out/../../secrets.env"]) {
      expect(out(await share(noBucket).execute("c1", { path: bad }))).toContain(
        "outside your workspace",
      );
    }
  });

  it("reports a missing file and a directory differently from a rejection", async () => {
    expect(out(await share(noBucket).execute("c1", { path: "nope.txt" }))).toContain(
      "does not exist",
    );
    expect(out(await share(noBucket).execute("c1", { path: "out" }))).toContain("is a directory");
  });

  it("requires a path", async () => {
    expect(out(await share(noBucket).execute("c1", {}))).toContain("path required");
  });
});
