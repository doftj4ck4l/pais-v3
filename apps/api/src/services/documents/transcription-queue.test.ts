import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteTranscriptionStore } from "../../repositories/transcription.repository";
import { SqliteDocumentStore } from "../../repositories/document.repository";
import { createTranscriber, TranscriptionQueueFullError } from "./transcription-queue";

function fresh() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  const db = drizzle(sqlite) as any;
  return {
    store: new SqliteTranscriptionStore(db),
    docs: new SqliteDocumentStore(db),
  };
}

/** A transcript that lands in the corpus, linked to the job row. */
function okRun(docs: SqliteDocumentStore) {
  const run = async ({ title }: { title: string }) => {
    await docs.save(
      { id: `doc_${title}_${Math.random().toString(36).slice(2, 8)}`, workspaceId: "ws1", title, bytes: 4, pages: 1, status: "indexed", error: null },
      [],
    );
    return { ok: true as const, documentId: (await docs.list("ws1"))[0]!.id, chunks: 1, model: "whisper-1", language: "en", text: "[00:00] hello" };
  };
  return run;
}

const audio = (mb: number) => new Uint8Array(mb * 1024 * 1024);

describe("transcriptionQueue", () => {
  it("runs queued jobs in FIFO order, one at a time, and marks them done", async () => {
    const { store, docs } = fresh();
    const order: string[] = [];
    const seen: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const stages: string[] = [];

    const queue = createTranscriber({
      store,
      run: async (job, reportStage) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        order.push(job.title);
        seen.push(job.title);
        await new Promise((r) => setTimeout(r, 5));
        await reportStage("indexing");
        stages.push((await store.find("ws1", job.id))!.status);
        inflight -= 1;
        await docs.save(
          {
            id: `doc_${job.id}`,
            workspaceId: "ws1",
            title: job.title,
            bytes: "bytes" in job ? job.bytes.byteLength : job.byteLength,
            pages: 1,
            status: "indexed",
            error: null,
          },
          [],
        );
        return { ok: true as const, documentId: `doc_${job.id}`, chunks: 1, model: "whisper-1", language: "en", text: "[00:00] hello" };
      },
    });

    await queue.enqueue({ workspaceId: "ws1", title: "a.mp3", bytes: audio(1), contentType: "audio/mpeg" });
    await queue.enqueue({ workspaceId: "ws1", title: "b.mp3", bytes: audio(1), contentType: "audio/mpeg" });
    await queue.enqueue({ workspaceId: "ws1", title: "c.mp3", bytes: audio(1), contentType: "audio/mpeg" });

    await waitUntilDone(store);
    expect(order).toEqual(["a.mp3", "b.mp3", "c.mp3"]);
    expect(seen).toEqual(order);
    expect(maxInflight).toBe(1);
    expect(stages).toEqual(["indexing", "indexing", "indexing"]);

    const rows = await store.list("ws1");
    expect(rows.every((r) => r.status === "done")).toBe(true);
    expect(rows.map((r) => r.title)).toEqual(["c.mp3", "b.mp3", "a.mp3"]); // newest first
    expect(rows.every((r) => r.documentId?.startsWith("doc_trx_"))).toBe(true);
  });

  it("marks a failing job failed with the reason, and continues to the next", async () => {
    const { store, docs } = fresh();
    const queue = createTranscriber({
      store,
      run: async (job) => {
        if (job.title === "b.mp3") return { ok: false as const, error: "whisper model whisper-1 refused: nope" };
        await docs.save(
          { id: `doc_${job.id}`, workspaceId: "ws1", title: job.title, bytes: 1, pages: 1, status: "indexed", error: null },
          [],
        );
        return { ok: true as const, documentId: `doc_${job.id}`, chunks: 1, model: "whisper-1", language: "en", text: "[00:00] hello" };
      },
    });

    await queue.enqueue({ workspaceId: "ws1", title: "a.mp3", bytes: audio(1), contentType: "audio/mpeg" });
    await queue.enqueue({ workspaceId: "ws1", title: "b.mp3", bytes: audio(1), contentType: "audio/mpeg" });
    await queue.enqueue({ workspaceId: "ws1", title: "c.mp3", bytes: audio(1), contentType: "audio/mpeg" });

    await waitUntilDone(store);
    const rows = await store.list("ws1");
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(byTitle["a.mp3"]!.status).toBe("done");
    expect(byTitle["c.mp3"]!.status).toBe("done");
    expect(byTitle["b.mp3"]!.status).toBe("failed");
    expect(byTitle["b.mp3"]!.error).toContain("refused");
  });

  it("survives a thrown run and does not stall the queue", async () => {
    const { store, docs } = fresh();
    const queue = createTranscriber({
      store,
      run: async (job) => {
        if (job.title === "boom.mp3") throw new Error("ECONNREFUSED");
        await docs.save(
          { id: `doc_${job.id}`, workspaceId: "ws1", title: job.title, bytes: 1, pages: 1, status: "indexed", error: null },
          [],
        );
        return { ok: true as const, documentId: `doc_${job.id}`, chunks: 1, model: "whisper-1", language: "en", text: "[00:00] hello" };
      },
    });

    await queue.enqueue({ workspaceId: "ws1", title: "boom.mp3", bytes: audio(1), contentType: "audio/mpeg" });
    await queue.enqueue({ workspaceId: "ws1", title: "after.mp3", bytes: audio(1), contentType: "audio/mpeg" });

    await waitUntilDone(store);
    const rows = await store.list("ws1");
    expect(rows.find((r) => r.title === "boom.mp3")!.status).toBe("failed");
    expect(rows.find((r) => r.title === "after.mp3")!.status).toBe("done");
  });

  it("cleans up disk-backed recordings after success or failure", async () => {
    const { store, docs } = fresh();
    const cleaned: string[] = [];
    const queue = createTranscriber({
      store,
      run: async (job) => {
        if (job.title === "failed.mp4") return { ok: false as const, error: "no speech" };
        await docs.save(
          {
            id: "doc_ok",
            workspaceId: "ws1",
            title: job.title,
            bytes: "bytes" in job ? job.bytes.byteLength : job.byteLength,
            pages: 1,
            status: "indexed",
            error: null,
          },
          [],
        );
        return {
          ok: true as const,
          documentId: "doc_ok",
          chunks: 1,
          model: "whisper-1",
          language: "en",
          text: "[00:00] hello",
        };
      },
    });

    await queue.enqueue({
      workspaceId: "ws1",
      title: "done.mp4",
      filePath: "/tmp/done",
      byteLength: 728_400_000,
      contentType: "video/mp4",
      cleanup: async () => { cleaned.push("done.mp4"); },
    });
    await queue.enqueue({
      workspaceId: "ws1",
      title: "failed.mp4",
      filePath: "/tmp/failed",
      byteLength: 12,
      contentType: "video/mp4",
      cleanup: async () => { cleaned.push("failed.mp4"); },
    });

    await waitUntilDone(store);
    expect(cleaned).toEqual(["done.mp4", "failed.mp4"]);
  });

  it("refuses to enqueue once the line is full", async () => {
    const { store } = fresh();
    const queue = createTranscriber({
      store,
      run: async () => new Promise(() => {}), // a job that never advances
    });
    await queue.enqueue({ workspaceId: "ws1", title: "a.mp3", bytes: audio(1600), contentType: "audio/mpeg" });
    await queue.enqueue({ workspaceId: "ws1", title: "b.mp3", bytes: audio(1600), contentType: "audio/mpeg" });

    // `a.mp3` is already in flight (past the cap check), `b.mp3` is waiting.
    expect(queue.pendingCount()).toBe(1);
    await expect(
      queue.enqueue({ workspaceId: "ws1", title: "too-much.mp3", bytes: audio(1600), contentType: "audio/mpeg" }),
    ).rejects.toBeInstanceOf(TranscriptionQueueFullError);
  });

  it("recoverInterrupted closes jobs left by a previous process", async () => {
    const { store } = fresh();
    const queue = createTranscriber({ store });
    await store.create({ id: "trx_stale", workspaceId: "ws1", title: "stale.mp3", bytes: 4 });
    await store.markTranscribing("trx_stale");

    expect(await queue.recoverInterrupted()).toBe(1);
    const rows = await store.list("ws1");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toContain("restarted");
  });
});

const waitUntilDone = async (store: SqliteTranscriptionStore, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    const rows = await store.list("ws1");
    if (rows.length && rows.every((r) => !["queued", "transcribing", "indexing"].includes(r.status))) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("queue never drained");
};
