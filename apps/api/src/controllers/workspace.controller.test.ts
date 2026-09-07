import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../config/env";
import { MAX_DATA_FILE_BYTES } from "../services/media/workspace-upload";

const originalBackend = env.sandboxBackend;
const originalRoot = env.sandboxRoot;
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-upload-controller-"));
let createApp: typeof import("../app").createApp;

const headers = { "x-authentik-uid": "workspace-upload-user" };

beforeAll(async () => {
  (env as { sandboxBackend: string }).sandboxBackend = "node";
  (env as { sandboxRoot: string }).sandboxRoot = sandboxRoot;
  const { ensureSchema } = await import("../db/client");
  ensureSchema();
  ({ createApp } = await import("../app"));
});

afterAll(() => {
  (env as { sandboxBackend: string }).sandboxBackend = originalBackend;
  (env as { sandboxRoot: string }).sandboxRoot = originalRoot;
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

async function workspaceId(): Promise<string> {
  const listed = await createApp().request("/api/workspaces", { headers });
  const body = (await listed.json()) as { workspaces: { id: string }[] };
  if (body.workspaces[0]) return body.workspaces[0].id;
  const created = await createApp().request("/api/workspaces", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Uploads" }),
  });
  return ((await created.json()) as { workspace: { id: string } }).workspace.id;
}

describe("POST /api/workspace/files", () => {
  it("writes an attached CSV into the caller's workspace", async () => {
    const id = await workspaceId();
    const form = new FormData();
    form.append("file", new File(["name,total\nA,10\n"], "sales.csv", { type: "text/csv" }));

    const response = await createApp().request(`/api/workspace/files?workspaceId=${id}`, {
      method: "POST",
      headers,
      body: form,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { file: { path: string; name: string; bytes: number } };
    expect(body.file).toMatchObject({ name: "sales.csv", bytes: 16 });
    expect(fs.readFileSync(path.join(sandboxRoot, id, body.file.path), "utf8")).toBe("name,total\nA,10\n");
  });

  it("reports unsupported files without writing them", async () => {
    const id = await workspaceId();
    const form = new FormData();
    form.append("file", new File(["not a sheet"], "notes.txt", { type: "text/plain" }));

    const response = await createApp().request(`/api/workspace/files?workspaceId=${id}`, {
      method: "POST",
      headers,
      body: form,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Only .csv, .xlsx, .pdf, .docx and .pptx files can be attached for data analysis.",
    });
  });

  it("returns payload-too-large for a file over the analysis limit", async () => {
    const id = await workspaceId();
    const form = new FormData();
    form.append("file", new File([new Uint8Array(MAX_DATA_FILE_BYTES + 1)], "large.csv"));

    const response = await createApp().request(`/api/workspace/files?workspaceId=${id}`, {
      method: "POST",
      headers,
      body: form,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "The attached file is 26.2MB, over the 25MB limit.",
    });
  });
});
