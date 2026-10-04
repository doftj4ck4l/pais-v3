import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptionStore } from "./repositories/transcription.repository";
import { documentStore } from "./repositories/document.repository";

/**
 * Drives the finished-transcript download against the real HTTP surface: a
 * done job in one workspace, and two calls that must come back empty.
 */
let dir: string;
let createApp: typeof import("./app").createApp;
let workspaceId: string;

const asUser = (id: string) => ({ headers: { "x-authentik-uid": id } });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-docs-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));

  const created = await createApp().request("/api/workspaces", {
    method: "POST",
    headers: { ...asUser("transcript-owner").headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Research" }),
  });
  expect(created.status).toBe(201);
  workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;

  await transcriptionStore.create(
    { id: "trx_demo", workspaceId, title: "meeting.mp3", bytes: 1234 },
    1,
  );
  // `document_id` is a real foreign key — the corpus row must exist first.
  await documentStore.save(
    { id: "doc_demo", workspaceId, title: "meeting.mp3", bytes: 4321, pages: 0, status: "indexed", error: null },
    [],
  );
  await transcriptionStore.markDone(
    "trx_demo",
    "doc_demo",
    "whisper-1",
    "[00:00] the quarterly budget is forty thousand\n[00:05] ship before the end of May",
    2,
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the transcript download", () => {
  it("serves a done job as a .txt download", async () => {
    const res = await createApp().request(
      `/api/documents/transcriptions/trx_demo/transcript?workspaceId=${workspaceId}`,
      asUser("transcript-owner"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("meeting.txt");
    expect(await res.text()).toContain("[00:00] the quarterly budget");
  });

  it("keeps one workspace's transcript out of another's", async () => {
    const other = await createApp().request("/api/workspaces", {
      method: "POST",
      headers: { ...asUser("transcript-eavesdropper").headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Elsewhere" }),
    });
    const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;

    const res = await createApp().request(
      `/api/documents/transcriptions/trx_demo/transcript?workspaceId=${otherId}`,
      asUser("transcript-eavesdropper"),
    );
    expect(res.status).toBe(404);
  });

  it("answers 404 for a job that is not done", async () => {
    await transcriptionStore.create(
      { id: "trx_pending", workspaceId, title: "later.mp3", bytes: 1 },
      3,
    );

    const res = await createApp().request(
      `/api/documents/transcriptions/trx_pending/transcript?workspaceId=${workspaceId}`,
      asUser("transcript-owner"),
    );
    expect(res.status).toBe(404);
  });

  it("serves the same transcript as pdf and docx", async () => {
    const pdf = await createApp().request(
      `/api/documents/transcriptions/trx_demo/transcript?format=pdf&workspaceId=${workspaceId}`,
      asUser("transcript-owner"),
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("meeting.pdf");
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.slice(0, 4))).toBe("%PDF");

    const docx = await createApp().request(
      `/api/documents/transcriptions/trx_demo/transcript?format=docx&workspaceId=${workspaceId}`,
      asUser("transcript-owner"),
    );
    expect(docx.status).toBe(200);
    expect(docx.headers.get("content-type")).toContain("wordprocessingml");
    expect(docx.headers.get("content-disposition")).toContain("meeting.docx");
    const docxBytes = new Uint8Array(await docx.arrayBuffer());
    expect(new TextDecoder().decode(docxBytes.slice(0, 2))).toBe("PK");
  });

  it("rejects an unsupported transcript format", async () => {
    const res = await createApp().request(
      `/api/documents/transcriptions/trx_demo/transcript?format=csv&workspaceId=${workspaceId}`,
      asUser("transcript-owner"),
    );
    expect(res.status).toBe(400);
  });
});
