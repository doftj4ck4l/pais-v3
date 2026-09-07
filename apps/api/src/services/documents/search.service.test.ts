import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteDocumentStore } from "../../repositories/document.repository";
import { searchDocuments, toFtsQuery } from "./search.service";

/**
 * A real in-memory database with the production schema. FTS5 ranking, stemming,
 * and MATCH syntax errors cannot be faked — the point of these tests is that the
 * queries we build actually survive SQLite.
 */
function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteDocumentStore(drizzle(sqlite) as any);
}

const seed = async (store: ReturnType<typeof freshStore>, workspaceId = "ws1") => {
  await store.save(
    { id: "d1", workspaceId, title: "policy.pdf", bytes: 100, pages: 2, status: "indexed" },
    [
      { seq: 0, page: 4, text: "Enterprise customers may cancel within 30 days of renewal for a full refund." },
      { seq: 1, page: 2, text: "Standard plans are billed monthly and are non-refundable after seven days." },
    ],
  );
  await store.save(
    { id: "d2", workspaceId, title: "handbook.pdf", bytes: 50, pages: 1, status: "indexed" },
    [{ seq: 0, page: 1, text: "The office is closed on public holidays." }],
  );
};

describe("toFtsQuery", () => {
  it("quotes every term so FTS5 operators in prose are literals", () => {
    // Bare NOT/OR/AND would otherwise be parsed as operators.
    expect(toFtsQuery("cancel NOT refund")).toBe('"cancel" OR "not" OR "refund"');
  });

  it("strips punctuation that would be a MATCH syntax error", () => {
    expect(toFtsQuery("What's our refund window?")).toBe('"refund" OR "window"');
  });

  it("drops question scaffolding but keeps content words", () => {
    expect(toFtsQuery("what is the refund policy")).toBe('"refund" OR "policy"');
  });

  it("de-duplicates repeated terms", () => {
    expect(toFtsQuery("refund refund REFUND")).toBe('"refund"');
  });

  it("falls back to raw words when the question is all stopwords", () => {
    expect(toFtsQuery("who are we?")).toBe('"who" OR "are" OR "we"');
  });

  it("returns null when nothing searchable remains", () => {
    expect(toFtsQuery("?!  ...")).toBeNull();
    expect(toFtsQuery("")).toBeNull();
  });

  it("keeps digits and non-ASCII letters", () => {
    expect(toFtsQuery("error 4032 café")).toBe('"error" OR "4032" OR "café"');
  });
});

describe("searchDocuments", () => {
  it("ranks the best passage first and cites its page", async () => {
    const store = freshStore();
    await seed(store);
    const res = await searchDocuments("ws1", "enterprise refund window", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits[0]!.docTitle).toBe("policy.pdf");
    expect(res.hits[0]!.page).toBe(4);
    expect(res.hits[0]!.score).toBeGreaterThan(0);
  });

  it("matches refundable when asked about refund (porter stemming)", async () => {
    const store = freshStore();
    await seed(store);
    const res = await searchDocuments("ws1", "refund", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits.map((h) => h.page).sort()).toEqual([2, 4]);
  });

  it("survives a raw question containing FTS5 metacharacters", async () => {
    const store = freshStore();
    await seed(store);
    for (const q of [
      `What's our "refund" window for enterprise customers?`,
      "cancel OR (refund AND NOT renewal)",
      "50% off -- really?",
      "a * b ^ c",
    ]) {
      const res = await searchDocuments("ws1", q, 5, store);
      expect(res.ok).toBe(true);
    }
  });

  it("never returns another workspace's chunks", async () => {
    const store = freshStore();
    await seed(store, "ws1");
    const res = await searchDocuments("ws2", "refund", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits).toEqual([]);
  });

  it("never returns another workspace's name matches", async () => {
    const store = freshStore();
    await seed(store, "ws1");
    const res = await searchDocuments("ws2", "policy", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits).toEqual([]);
  });

  it("finds a document by its filename even when the body does not match", async () => {
    // The user's complaint: a transcript indexed against its upload title
    // ("Azmin.m4a") never surfaced when asked about by name, because FTS only
    // searches chunk text. Title matching must surface it.
    const store = freshStore();
    await seed(store);
    await store.save(
      { id: "d3", workspaceId: "ws1", title: "Azmin.m4a", bytes: 100, pages: 1, status: "indexed" },
      [{ seq: 0, page: 1, text: "[00:00] Bermulanya mesyuarat MBSJ–PAIS v3 dengan kehadiran Ahli Majlis." }],
    );

    const res = await searchDocuments("ws1", "what is in Azmin.m4a", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits[0]!.docTitle).toBe("Azmin.m4a");
    expect(res.hits[0]!.text).toContain("mesyuarat");
  });

  it("ranks a title match above a real body match from another document", async () => {
    const store = freshStore();
    await seed(store);
    await store.save(
      { id: "d3", workspaceId: "ws1", title: "azmin-notes.m4a", bytes: 100, pages: 1, status: "indexed" },
      [{ seq: 0, page: 1, text: "Jadual mesyuarat akan dikemas kini oleh unit SUK." }],
    );
    // "holidays" only appears in handbook.pdf's body, but the query names
    // Azmin's file — the name match must lead.
    const res = await searchDocuments("ws1", "azmin holidays", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits[0]!.docTitle).toBe("azmin-notes.m4a");
  });

  it("dedupes a chunk that matched both by title and by body", async () => {
    const store = freshStore();
    await seed(store);
    // "enterprise" matches the body of policy.pdf's first chunk; "policy"
    // matches its title. Both searches return that same chunk, which must be
    // reported once.
    const res = await searchDocuments("ws1", "enterprise policy", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.hits.map((h) => h.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours the limit with name matches filling the window", async () => {
    const store = freshStore();
    await store.save(
      { id: "a1", workspaceId: "ws1", title: "Azmin.m4a", bytes: 100, pages: 1, status: "indexed" },
      [{ seq: 0, page: 1, text: "mesyuarat MBSJ–PAIS v3" }],
    );
    await store.save(
      { id: "a2", workspaceId: "ws1", title: "Azlin.m4a", bytes: 100, pages: 1, status: "indexed" },
      [{ seq: 0, page: 1, text: "mesyuarat MBSJ–PAIS v3" }],
    );
    const res = await searchDocuments("ws1", "Azmin", 1, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.docTitle).toBe("Azmin.m4a");
  });

  it("reports no-terms instead of throwing on an unsearchable query", async () => {
    const store = freshStore();
    await seed(store);
    const res = await searchDocuments("ws1", "!!!", 5, store);
    expect(res).toEqual({ ok: false, reason: "no-terms" });
  });

  it("excludes documents that produced no text layer", async () => {
    const store = freshStore();
    await store.save(
      { id: "d3", workspaceId: "ws1", title: "scan.pdf", bytes: 9, pages: 3, status: "empty", error: "no text layer" },
      [],
    );
    const res = await searchDocuments("ws1", "anything", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits).toEqual([]);
  });

  it("honours the limit", async () => {
    const store = freshStore();
    await seed(store);
    const res = await searchDocuments("ws1", "refund days plans", 1, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits).toHaveLength(1);
  });

  it("drops a deleted document out of the index", async () => {
    const store = freshStore();
    await seed(store);
    expect(await store.remove("ws1", "d1")).toBe(true);
    const res = await searchDocuments("ws1", "refund", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits).toEqual([]);
  });

  it("refuses to delete a document owned by someone else", async () => {
    const store = freshStore();
    await seed(store, "ws1");
    expect(await store.remove("ws2", "d1")).toBe(false);
    const res = await searchDocuments("ws1", "refund", 5, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hits.length).toBeGreaterThan(0);
  });
});
