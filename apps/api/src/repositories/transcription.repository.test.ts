import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteTranscriptionStore } from "./transcription.repository";
import { SqliteDocumentStore } from "./document.repository";

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return {
    store: new SqliteTranscriptionStore(drizzle(sqlite) as any),
    docs: new SqliteDocumentStore(drizzle(sqlite) as any),
  };
}

describe("SqliteTranscriptionStore", () => {
  it("creates a job queued, then walks it through terminal states", async () => {
    const { store, docs } = freshStore();
    const row = await store.create({ id: "trx_1", workspaceId: "ws1", title: "call.mp3", bytes: 1024 });

    expect(row.status).toBe("queued");
    expect(row.error).toBeNull();
    expect(row.documentId).toBeNull();

    // `document_id` is a real foreign key: the transcript row must exist first.
    await docs.save(
      { id: "doc_9", workspaceId: "ws1", title: "call.mp3", bytes: 512, pages: 1, status: "indexed", error: null },
      [],
    );

    await store.markTranscribing(row.id);
    await store.markIndexing(row.id);
    expect((await store.find("ws1", row.id))!.status).toBe("indexing");
    await store.markDone(row.id, "doc_9", "whisper-1", "[00:00] quarterly budget");

    const [listed] = await store.list("ws1");
    expect(listed!.status).toBe("done");
    expect(listed!.documentId).toBe("doc_9");
    expect(listed!.model).toBe("whisper-1");
    expect(listed!.transcriptText).toContain("quarterly");
    expect(listed!.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
  });

  it("records a failure with the reason", async () => {
    const { store } = freshStore();
    const row = await store.create({ id: "trx_2", workspaceId: "ws1", title: "call.mp3", bytes: 1024 });
    await store.markFailed(row.id, "whisper model refused: nope");

    const [listed] = await store.list("ws1");
    expect(listed!.status).toBe("failed");
    expect(listed!.error).toContain("refused");
  });

  it("keeps each workspace's jobs separate", async () => {
    const { store } = freshStore();
    await store.create({ id: "trx_3", workspaceId: "ws1", title: "a.mp3", bytes: 1 });
    await store.create({ id: "trx_4", workspaceId: "ws2", title: "b.mp3", bytes: 2 });

    const asOne = await store.list("ws1");
    expect(asOne).toHaveLength(1);
    expect(asOne[0]!.id).toBe("trx_3");
    expect(await store.find("ws2", "trx_3")).toBeNull();
  });

  it("removes only its own job, by id", async () => {
    const { store } = freshStore();
    await store.create({ id: "trx_5", workspaceId: "ws1", title: "a.mp3", bytes: 1 });
    await store.create({ id: "trx_6", workspaceId: "ws1", title: "b.mp3", bytes: 2 });

    expect(await store.remove("ws1", "trx_5")).toBe(true);
    expect(await store.remove("ws2", "trx_6")).toBe(false); // another workspace
    expect(await store.list("ws1")).toHaveLength(1);
  });

  it("closes jobs orphaned by a previous process", async () => {
    const { store } = freshStore();
    const queued = await store.create({ id: "trx_7", workspaceId: "ws1", title: "a.mp3", bytes: 1 });
    await store.create({ id: "trx_8", workspaceId: "ws1", title: "b.mp3", bytes: 1 });
    await store.markTranscribing(queued.id);
    await store.markIndexing("trx_8");

    expect(await store.stopInterrupted()).toBe(2);

    const done = await store.list("ws1");
    expect(done.every((r) => r.status === "failed")).toBe(true);
    expect(done[0]!.error).toContain("restarted");
    expect(await store.stopInterrupted()).toBe(0);
  });
});
