import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";

let dir: string;
let createApp: typeof import("./app").createApp;
let documentStore: typeof import("./repositories/document.repository").documentStore;
let transcriptionStore: typeof import("./repositories/transcription.repository").transcriptionStore;
let rangedAudioResponse: typeof import("./controllers/document.controller").rangedAudioResponse;
let workspaceRegistry: typeof import("./repositories/workspace-registry.repository").workspaceRegistry;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-transcription-detail-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  const db = await import("./db/client");
  db.ensureSchema();
  ({ createApp } = await import("./app"));
  ({ documentStore } = await import("./repositories/document.repository"));
  ({ transcriptionStore } = await import("./repositories/transcription.repository"));
  ({ rangedAudioResponse } = await import("./controllers/document.controller"));
  ({ workspaceRegistry } = await import("./repositories/workspace-registry.repository"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("GET /api/documents/:id", () => {
  it("returns searchable text only through its owning workspace", async () => {
    const suffix = Date.now();
    const owner = `document-owner-${suffix}`;
    const stranger = `document-stranger-${suffix}`;
    const workspace = await workspaceRegistry.create(owner, "Research");
    await workspaceRegistry.create(stranger, "Other research");
    const documentId = `doc_detail_${suffix}`;

    await documentStore.save(
      {
        id: documentId,
        workspaceId: workspace.id,
        title: "field-notes.pdf",
        bytes: 64,
        pages: 2,
        status: "indexed",
      },
      [
        { seq: 0, page: 1, text: "First searchable paragraph." },
        { seq: 1, page: 2, text: "Second searchable paragraph." },
      ],
    );

    const owned = await createApp().request(
      `/api/documents/${documentId}?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": owner } },
    );
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      document: {
        title: "field-notes.pdf",
        content: expect.stringContaining("Second searchable paragraph."),
        chunkCount: 2,
      },
    });

    const hidden = await createApp().request(
      `/api/documents/${documentId}?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": stranger } },
    );
    expect(hidden.status).toBe(404);
  });
});

describe("GET /api/documents/transcriptions/:id", () => {
  // The CI gate runs all 93 API test files concurrently on a small runner. This
  // otherwise-fast SQLite integration test can spend more than Bun's 5-second
  // default waiting for CPU and the shared module loader under that load.
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
      "[00:00] Opening note\n[00:12] Ship on Thursday",
    );

    const owned = await createApp().request(
      `/api/documents/transcriptions/trx_transcript_detail?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": owner } },
    );
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      transcription: { id: "trx_transcript_detail", status: "done", hasAudio: false },
      content: "[00:00] Opening note\n[00:12] Ship on Thursday",
      segments: [{ start: 0, text: "Opening note" }, { start: 12, text: "Ship on Thursday" }],
    });

    const hidden = await createApp().request(
      `/api/documents/transcriptions/trx_transcript_detail?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": stranger } },
    );
    expect(hidden.status).toBe(404);
  }, 15_000);

  it("streams a private byte range and reindexes corrected passages", async () => {
    const owner = `audio-owner-${Date.now()}`;
    const stranger = `audio-stranger-${Date.now()}`;
    const workspace = await workspaceRegistry.create(owner, "Recorded interviews");
    await workspaceRegistry.create(stranger, "Other interviews");
    const audioPath = path.join(dir, "review.mp3");
    fs.writeFileSync(audioPath, new Uint8Array([10, 20, 30, 40, 50]));

    await documentStore.save(
      { id: "doc_audio_review", workspaceId: workspace.id, title: "review.mp3", bytes: 20, pages: 1, status: "indexed" },
      [{ seq: 0, page: 1, text: "[00:00] Old wording" }],
    );
    await transcriptionStore.create({
      id: "trx_audio_review",
      workspaceId: workspace.id,
      title: "review.mp3",
      bytes: 5,
      audioPath: ".pixelspace/transcriptions/trx_audio_review.mp3",
      audioContentType: "audio/mpeg",
    });
    await transcriptionStore.markDone(
      "trx_audio_review",
      "doc_audio_review",
      "whisper-large-v3",
      "[00:00] Old wording",
    );

    const app = createApp();
    const ranged = rangedAudioResponse({
      relativePath: ".pixelspace/transcriptions/trx_audio_review.mp3",
      absolutePath: audioPath,
      byteLength: 5,
      contentType: "audio/mpeg",
      file: Bun.file(audioPath),
    }, "bytes=1-3");
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([20, 30, 40]));
    const invalidRange = rangedAudioResponse({
      relativePath: ".pixelspace/transcriptions/trx_audio_review.mp3",
      absolutePath: audioPath,
      byteLength: 5,
      contentType: "audio/mpeg",
      file: Bun.file(audioPath),
    }, "bytes=9-");
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("content-range")).toBe("bytes */5");

    // Exercise the real HTTP server, not only app.request()/Response.arrayBuffer().
    // Hono's CORS middleware reconstructs the response after the handler. Bun
    // 1.3 used to lose a BunFile slice's bounds at that boundary, so Safari's
    // two-byte metadata probe received the whole recording despite a 0-1 range.
    const audioApp = new Hono();
    audioApp.use("*", cors());
    audioApp.get("/audio", (c) => rangedAudioResponse({
      relativePath: ".pixelspace/transcriptions/trx_audio_review.mp3",
      absolutePath: audioPath,
      byteLength: 5,
      contentType: "audio/mpeg",
      file: Bun.file(audioPath),
    }, c.req.header("range")));
    const server = Bun.serve({ port: 0, fetch: audioApp.fetch });
    try {
      const url = `http://127.0.0.1:${server.port}/audio`;
      const probe = await fetch(url, { headers: { Range: "bytes=0-1" } });
      expect(probe.status).toBe(206);
      expect(probe.headers.get("content-length")).toBe("2");
      expect(probe.headers.get("content-range")).toBe("bytes 0-1/5");
      expect(new Uint8Array(await probe.arrayBuffer())).toEqual(new Uint8Array([10, 20]));

      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(full.headers.get("content-length")).toBe("5");
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    } finally {
      await server.stop(true);
    }

    const hidden = await app.request(
      `/api/documents/transcriptions/trx_audio_review/audio?workspaceId=${workspace.id}`,
      { headers: { "x-authentik-uid": stranger } },
    );
    expect(hidden.status).toBe(404);

    const edited = await app.request(
      `/api/documents/transcriptions/trx_audio_review?workspaceId=${workspace.id}`,
      {
        method: "PATCH",
        headers: { "x-authentik-uid": owner, "content-type": "application/json" },
        body: JSON.stringify({ segments: [
          { start: 0, text: "Correct opening" },
          { start: 8, text: "Approved decision" },
        ] }),
      },
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      transcription: { id: "trx_audio_review", hasAudio: true },
      content: "[00:00] Correct opening\n[00:08] Approved decision",
    });
    expect((await documentStore.read(workspace.id, "doc_audio_review"))?.content).toContain("Approved decision");
    expect((await transcriptionStore.find(workspace.id, "trx_audio_review"))?.transcriptText).not.toContain("Old wording");
    expect(await documentStore.search(workspace.id, "Approved", 5)).toHaveLength(1);
    expect(await documentStore.search(workspace.id, "Old", 5)).toHaveLength(0);

    const hiddenEdit = await app.request(
      `/api/documents/transcriptions/trx_audio_review?workspaceId=${workspace.id}`,
      {
        method: "PATCH",
        headers: { "x-authentik-uid": stranger, "content-type": "application/json" },
        body: JSON.stringify({ segments: [{ start: 0, text: "Tampered" }] }),
      },
    );
    expect(hiddenEdit.status).toBe(404);
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

  it("accepts a 728.4MB recording and rejects only above 2GiB", async () => {
    const owner = `oversized-upload-${Date.now()}`;
    const workspace = await workspaceRegistry.create(owner, "Large recordings");
    const app = createApp();
    const accepted = await app.request(
      `/api/documents/transcription-uploads?workspaceId=${workspace.id}`,
      {
        method: "POST",
        headers: { "x-authentik-uid": owner, "content-type": "application/json" },
        body: JSON.stringify({ title: "500.mp4", contentType: "video/mp4", size: 728_400_000 }),
      },
    );

    expect(accepted.status).toBe(201);
    const session = await accepted.json() as { uploadId: string };
    const cancelled = await app.request(
      `/api/documents/transcription-uploads/${session.uploadId}?workspaceId=${workspace.id}`,
      { method: "DELETE", headers: { "x-authentik-uid": owner } },
    );
    expect(cancelled.status).toBe(204);

    const response = await app.request(
      `/api/documents/transcription-uploads?workspaceId=${workspace.id}`,
      {
        method: "POST",
        headers: { "x-authentik-uid": owner, "content-type": "application/json" },
        body: JSON.stringify({ title: "too-large.wav", contentType: "audio/wav", size: 2049 * 1024 * 1024 }),
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringContaining("2048MiB limit") });
  });
});
