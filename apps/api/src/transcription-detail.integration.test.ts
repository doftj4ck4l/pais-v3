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
