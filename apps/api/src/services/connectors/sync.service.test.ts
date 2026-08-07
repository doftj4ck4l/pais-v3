import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { env } from "../../config/env";
import { SqliteConnectorStore, type OAuthTokens } from "../../repositories/connector.repository";
import { SqliteDocumentStore } from "../../repositories/document.repository";
import { handlingFor, type SourceFile } from "./google-drive";
import { syncConnector, type SourceProvider } from "./sync.service";

/**
 * The sync against a real in-memory database and a fake source.
 *
 * Faking the *provider* and not the database is the split that matters: the
 * behaviour worth testing is what a second sync does to rows a first sync
 * wrote, and that lives in SQLite — including the FTS mirror, which cannot be
 * meaningfully faked.
 */

(env as { connectionSecret: string }).connectionSecret = "test-secret";

let sqlite: Database;
let store: SqliteConnectorStore;
let docs: SqliteDocumentStore;

const tokens: OAuthTokens = {
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: Date.now() + 3_600_000,
};

function file(id: string, version: string, over: Partial<SourceFile> = {}): SourceFile {
  return {
    externalId: id,
    title: `${id}.doc`,
    version,
    url: `https://drive.example/${id}`,
    mimeType: "application/vnd.google-apps.document",
    bytes: 0,
    ...over,
  };
}

/** A provider whose listing and content the test controls outright. */
function fakeProvider(over: Partial<SourceProvider> = {}): SourceProvider & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    needsRefresh: () => false,
    refresh: async (t) => t,
    startCursor: async () => "cursor-1",
    recentFiles: async () => [],
    handlingFor,
    fetchContent: async (_t, f) => {
      fetched.push(f.externalId);
      return { text: `contents of ${f.title}` };
    },
    ...over,
  } as SourceProvider & { fetched: string[] };
}

async function connector(): Promise<string> {
  await store.create({
    id: "con1",
    workspaceId: "ws1",
    kind: "gdrive",
    accountEmail: "a@example.com",
    tokens,
  });
  return "con1";
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  const d = drizzle(sqlite) as never;
  store = new SqliteConnectorStore(d);
  docs = new SqliteDocumentStore(d);
});

describe("syncConnector", () => {
  it("indexes each file once, searchable by its content", async () => {
    const id = await connector();
    const provider = fakeProvider({ recentFiles: async () => [file("a", "1"), file("b", "1")] });

    const out = await syncConnector("ws1", id, store, docs, provider, 50);
    expect(out.indexed).toBe(2);

    // Through the real FTS index, not by reading rows back: an indexed document
    // that cannot be searched has not been indexed.
    const hits = await docs.search("ws1", "contents", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.docTitle).sort()).toEqual(["a.doc", "b.doc"]);
  });

  it("records where each document came from", async () => {
    const id = await connector();
    await syncConnector("ws1", id, store, docs, fakeProvider({ recentFiles: async () => [file("a", "7")] }), 50);

    const [doc] = await docs.list("ws1");
    expect(doc!.connectorId).toBe(id);
    expect(doc!.externalId).toBe("a");
    expect(doc!.externalVersion).toBe("7");
    expect(doc!.externalUrl).toBe("https://drive.example/a");
  });

  it("skips an unchanged file without fetching its content", async () => {
    const id = await connector();
    const files = [file("a", "1")];

    await syncConnector("ws1", id, store, docs, fakeProvider({ recentFiles: async () => files }), 50);
    const second = fakeProvider({ recentFiles: async () => files });
    const out = await syncConnector("ws1", id, store, docs, second, 50);

    expect(out.unchanged).toBe(1);
    expect(out.indexed).toBe(0);
    // Fetching is the expensive half of a sync; the version check exists to
    // avoid it, so "did not download" is the assertion, not "did not index".
    expect(second.fetched).toEqual([]);
    expect(await docs.list("ws1")).toHaveLength(1);
  });

  it("replaces a changed file rather than indexing it twice", async () => {
    const id = await connector();
    await syncConnector("ws1", id, store, docs, fakeProvider({ recentFiles: async () => [file("a", "1")] }), 50);

    const out = await syncConnector(
      "ws1",
      id,
      store,
      docs,
      fakeProvider({
        recentFiles: async () => [file("a", "2")],
        fetchContent: async () => ({ text: "the revised text" }),
      }),
      50,
    );

    expect(out.updated).toBe(1);
    expect(await docs.list("ws1")).toHaveLength(1);

    // The old revision must be gone from the FTS mirror too, or a search cites
    // a sentence the document no longer contains.
    expect(await docs.search("ws1", "revised", 10)).not.toHaveLength(0);
    expect(await docs.search("ws1", "contents", 10)).toHaveLength(0);
  });

  it("removes a document whose file has disappeared", async () => {
    const id = await connector();
    await syncConnector(
      "ws1",
      id,
      store,
      docs,
      fakeProvider({ recentFiles: async () => [file("a", "1"), file("b", "1")] }),
      50,
    );

    const out = await syncConnector("ws1", id, store, docs, fakeProvider({ recentFiles: async () => [file("a", "1")] }), 50);
    expect(out.removed).toBe(1);
    expect((await docs.list("ws1")).map((d) => d.externalId)).toEqual(["a"]);
  });

  it("does not delete when the listing hit its limit", async () => {
    // A full page means there may be more files beyond it, so absence proves
    // nothing. Deleting here would wipe the index every sync.
    const id = await connector();
    await syncConnector(
      "ws1",
      id,
      store,
      docs,
      fakeProvider({ recentFiles: async () => [file("a", "1"), file("b", "1")] }),
      50,
    );

    const out = await syncConnector("ws1", id, store, docs, fakeProvider({ recentFiles: async () => [file("c", "1")] }), 1);
    expect(out.removed).toBe(0);
    expect(await docs.list("ws1")).toHaveLength(3);
  });

  it("carries on when one file fails to download", async () => {
    const id = await connector();
    const provider = fakeProvider({
      recentFiles: async () => [file("bad", "1"), file("good", "1")],
      fetchContent: async (_t, f) => {
        if (f.externalId === "bad") throw new Error("export restricted");
        return { text: "fine" };
      },
    });

    const out = await syncConnector("ws1", id, store, docs, provider, 50);
    expect(out.indexed).toBe(1);
    expect(out.failed).toEqual([{ title: "bad.doc", reason: "export restricted" }]);
  });

  it("names the files it skipped instead of dropping them silently", async () => {
    const id = await connector();
    const out = await syncConnector(
      "ws1",
      id,
      store,
      docs,
      fakeProvider({ recentFiles: async () => [file("img", "1", { mimeType: "image/png" })] }),
      50,
    );

    expect(out.skipped).toEqual([{ title: "img.doc", reason: "unsupported type image/png" }]);
    expect(await docs.list("ws1")).toHaveLength(0);
  });

  it("refreshes an expired token and stores the new one", async () => {
    const id = await connector();
    const refreshed: OAuthTokens = { accessToken: "at2", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 };

    await syncConnector(
      "ws1",
      id,
      store,
      docs,
      fakeProvider({ needsRefresh: () => true, refresh: async () => refreshed }),
      50,
    );

    // Persisted, not just used for this sync — otherwise every sync refreshes.
    expect((await store.tokens("ws1", id))!.accessToken).toBe("at2");
  });

  it("records the cursor and returns to connected", async () => {
    const id = await connector();
    await syncConnector("ws1", id, store, docs, fakeProvider(), 50);

    const row = (await store.get("ws1", id))!;
    expect(row.cursor).toBe("cursor-1");
    expect(row.status).toBe("connected");
    expect(row.lastSyncAt).toBeGreaterThan(0);
  });

  it("leaves the connector in error with the reason when the source fails", async () => {
    const id = await connector();
    const provider = fakeProvider({
      recentFiles: async () => {
        throw new Error("Drive /files failed (HTTP 403)");
      },
    });

    await expect(syncConnector("ws1", id, store, docs, provider, 50)).rejects.toThrow("403");
    const row = (await store.get("ws1", id))!;
    expect(row.status).toBe("error");
    expect(row.error).toContain("403");
  });

  it("does not touch another workspace's documents", async () => {
    const id = await connector();
    await store.create({
      id: "con2",
      workspaceId: "ws2",
      kind: "gdrive",
      accountEmail: "b@example.com",
      tokens,
    });
    await syncConnector("ws2", "con2", store, docs, fakeProvider({ recentFiles: async () => [file("z", "1")] }), 50);
    await syncConnector("ws1", id, store, docs, fakeProvider({ recentFiles: async () => [file("a", "1")] }), 50);

    expect(await docs.list("ws1")).toHaveLength(1);
    expect(await docs.list("ws2")).toHaveLength(1);
  });
});

describe("handlingFor", () => {
  it("exports Google-native types rather than downloading them", () => {
    // These have no bytes of their own; asking for the file body returns an
    // error, not a document.
    expect(handlingFor("application/vnd.google-apps.document")).toEqual({
      kind: "export",
      mimeType: "text/markdown",
    });
    expect(handlingFor("application/vnd.google-apps.spreadsheet")).toEqual({
      kind: "export",
      mimeType: "text/csv",
    });
  });

  it("sends PDFs to the extractor and text through untouched", () => {
    expect(handlingFor("application/pdf")).toEqual({ kind: "pdf" });
    expect(handlingFor("text/markdown")).toEqual({ kind: "text" });
    expect(handlingFor("application/json")).toEqual({ kind: "text" });
  });

  it("skips what it cannot read, and says what it was", () => {
    expect(handlingFor("image/png")).toEqual({ kind: "skip", reason: "unsupported type image/png" });
    expect(handlingFor("application/vnd.google-apps.folder").kind).toBe("skip");
  });
});
