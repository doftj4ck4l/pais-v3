import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;
let createApp: typeof import("./app").createApp;
let documentStore: typeof import("./repositories/document.repository").documentStore;
let transcriptionStore: typeof import("./repositories/transcription.repository").transcriptionStore;
let workspaceRegistry: typeof import("./repositories/workspace-registry.repository").workspaceRegistry;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-transcription-detail-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  const db = await import("./db/client");
  db.ensureSchema();
  ({ createApp } = await import("./app"));
  ({ documentStore } = await import("./repositories/document.repository"));
  ({ transcriptionStore } = await import("./repositories/transcription.repository"));
  ({ workspaceRegistry } = await import("./repositories/workspace-registry.repository"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("GET /api/documents/transcriptions/:id", () => {
  it("returns readable timestamped output only through its owning workspace", async () => {
    const owner = `transcript-owner-${Date.now()}`;
    const stranger = `transcript-stranger-${Date.now()}`;
    const workspace = await workspaceRegistry.create(owner, "Interviews");
    await workspaceRegistry.create(stranger, "Other");

    await documentStore.save(
      {
        id: "doc_transcript_detail",
        workspaceId: workspace.id,
        title: "planning.m4a",
        bytes: 50,
        pages: 1,
        status: "indexed",
      },
      [{ seq: 0, page: 1, text: "[00:00] Opening note\n[00:12] Ship on Thursday" }],
    );
    await transcriptionStore.create({
      id: "trx_transcript_detail",
      workspaceId: workspace.id,
      title: "planning.m4a",
      bytes: 12_000,
    });
    await transcriptionStore.markDone(
      "trx_transcript_detail",
      "doc_transcript_detail",
      "whisper-large-v3",
    );

    const owned = await createApp().request(
      `/api/documents/transcriptions/trx_transcript_detail?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": owner } },
    );
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      transcription: { id: "trx_transcript_detail", status: "done" },
      content: "[00:00] Opening note\n[00:12] Ship on Thursday",
    });

    const hidden = await createApp().request(
      `/api/documents/transcriptions/trx_transcript_detail?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": stranger } },
    );
    expect(hidden.status).toBe(404);
  });
});

describe("chunked transcription upload HTTP API", () => {
  it("accepts proxy-sized raw parts and keeps the session workspace-private", async () => {
    const owner = `upload-owner-${Date.now()}`;
    const stranger = `upload-stranger-${Date.now()}`;
    const workspace = await workspaceRegistry.create(owner, "Recordings");
    await workspaceRegistry.create(stranger, "Other recordings");
    const app = createApp();

    const created = await app.request(
      `/api/documents/transcription-uploads?workspaceId=${workspace.id}`,
      {
        method: "POST",
        headers: { "x-authentik-uid": owner, "content-type": "application/json" },
        body: JSON.stringify({ title: "town-hall.wav", contentType: "audio/wav", size: 4 }),
      },
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as { uploadId: string; chunkBytes: number; partCount: number };
    expect(session.chunkBytes).toBeLessThan(1024 * 1024);
    expect(session.partCount).toBe(1);

    const hidden = await app.request(
      `/api/documents/transcription-uploads/${session.uploadId}/chunks/0?workspaceId=${workspace.id}`,
      {
        method: "PUT",
        headers: { "x-authentik-uid": stranger, "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    );
    expect(hidden.status).toBe(404);

    const chunk = await app.request(
      `/api/documents/transcription-uploads/${session.uploadId}/chunks/0?workspaceId=${workspace.id}`,
      {
        method: "PUT",
        headers: { "x-authentik-uid": owner, "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    );
    expect(chunk.status).toBe(200);
    expect(await chunk.json()).toEqual({ receivedBytes: 4, nextPart: 1 });

    const cancelled = await app.request(
      `/api/documents/transcription-uploads/${session.uploadId}?workspaceId=${workspace.id}`,
      { method: "DELETE", headers: { "x-authentik-uid": owner } },
    );
    expect(cancelled.status).toBe(204);
  });

  it("rejects an oversized recording before receiving audio bytes", async () => {
    const owner = `oversized-upload-${Date.now()}`;
    const workspace = await workspaceRegistry.create(owner, "Large recordings");
    const response = await createApp().request(
      `/api/documents/transcription-uploads?workspaceId=${workspace.id}`,
      {
        method: "POST",
        headers: { "x-authentik-uid": owner, "content-type": "application/json" },
        body: JSON.stringify({ title: "too-large.wav", contentType: "audio/wav", size: 513 * 1024 * 1024 }),
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringContaining("512MiB limit") });
  });
});
