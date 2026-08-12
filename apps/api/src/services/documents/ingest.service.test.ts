import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteDocumentStore } from "../../repositories/document.repository";
import { ingestPdf } from "./ingest.service";
import { searchDocuments } from "./search.service";
import { makeImageOnlyPdf, makePdf } from "../testing/make-pdf";

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteDocumentStore(drizzle(sqlite) as any);
}

describe("ingestPdf", () => {
  it("indexes a real PDF end to end and makes it searchable with a citation", async () => {
    const store = freshStore();
    const pdf = makePdf([
      "Enterprise customers may cancel within 30 days of renewal for a full refund.",
      "The office is closed on public holidays.",
    ]);

    const res = await ingestPdf("ws1", "policy.pdf", pdf, store);
    expect(res.status).toBe("indexed");
    expect(res.pages).toBe(2);
    expect(res.chunks).toBeGreaterThan(0);

    const found = await searchDocuments("ws1", "How long do enterprise customers have to cancel?", 5, store);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.hits[0]!.docTitle).toBe("policy.pdf");
    expect(found.hits[0]!.page).toBe(1);
    expect(found.hits[0]!.text).toContain("30 days");
  });

  it("records the real file size, whatever the extractor does to the buffer", async () => {
    const store = freshStore();
    const pdf = makePdf(["Some indexable content on a page."]);
    const size = pdf.length;
    expect(size).toBeGreaterThan(0);

    const res = await ingestPdf("ws1", "sized.pdf", pdf, store);
    expect(res.status).toBe("indexed");
    expect((await store.list("ws1"))[0]!.bytes).toBe(size);
  });

  it("cites the page the answer actually came from", async () => {
    const store = freshStore();
    await ingestPdf("ws1", "handbook.pdf", makePdf([
      "Chapter one covers onboarding paperwork.",
      "Chapter two covers parental leave entitlements.",
      "Chapter three covers equipment returns.",
    ]), store);

    const found = await searchDocuments("ws1", "parental leave", 3, store);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.hits[0]!.page).toBe(2);
  });

  it("records a scanned PDF as empty with an explanation rather than a silent success", async () => {
    const store = freshStore();
    const res = await ingestPdf("ws1", "scan.pdf", makeImageOnlyPdf(3), store);

    expect(res.status).toBe("empty");
    expect(res.chunks).toBe(0);
    expect(res.pages).toBe(3);
    expect(res.error).toContain("text layer");
    expect(res.error).toContain("OCR");

    // It is listed, so the user can see what happened to their upload...
    const listed = await store.list("ws1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("empty");
    // ...but it never pollutes search results.
    const found = await searchDocuments("ws1", "anything", 5, store);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.hits).toEqual([]);
  });

  it("indexes the readable pages of a part-scanned PDF and says which it skipped", async () => {
    const store = freshStore();
    // Pages 2 and 4 carry no text layer, as if only those were scanned.
    const res = await ingestPdf("ws1", "mixed.pdf", makePdf([
      "Page one describes the annual leave allowance.",
      "",
      "Page three describes the equipment return process.",
      "",
    ]), store);

    expect(res.status).toBe("indexed");
    expect(res.chunks).toBe(2);
    expect(res.error).toContain("2 of 4");
    expect(res.error).toContain("OCR");

    // The pages that did extract are searchable, and cite their true page.
    const found = await searchDocuments("ws1", "equipment return", 5, store);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.hits[0]!.page).toBe(3);
  });

  it("records an unreadable file as an error instead of throwing", async () => {
    const store = freshStore();
    const junk = new TextEncoder().encode("this is definitely not a pdf");
    const res = await ingestPdf("ws1", "broken.pdf", junk, store);

    expect(res.status).toBe("error");
    expect(res.chunks).toBe(0);
    expect(res.error).toBeTruthy();
    expect((await store.list("ws1"))[0]!.status).toBe("error");
  });

  it("keeps each workspace's uploads separate", async () => {
    const store = freshStore();
    await ingestPdf("ws_alice", "alice.pdf", makePdf(["Alice's secret budget figures."]), store);
    await ingestPdf("ws_bob", "bob.pdf", makePdf(["Bob's unrelated notes."]), store);

    const asBob = await searchDocuments("ws_bob", "secret budget", 5, store);
    expect(asBob.ok).toBe(true);
    if (!asBob.ok) return;
    expect(asBob.hits.every((h) => h.docTitle === "bob.pdf")).toBe(true);
    expect(await store.list("ws_bob")).toHaveLength(1);
  });

  it("removes a document's chunks from search when deleted", async () => {
    const store = freshStore();
    const res = await ingestPdf("ws1", "temp.pdf", makePdf(["Distinctive phrase zanzibar."]), store);
    expect((await searchDocuments("ws1", "zanzibar", 5, store)) as any).toMatchObject({ ok: true });

    expect(await store.remove("ws1", res.documentId)).toBe(true);
    const after = await searchDocuments("ws1", "zanzibar", 5, store);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.hits).toEqual([]);
    expect(await store.list("ws1")).toEqual([]);
  });
});
