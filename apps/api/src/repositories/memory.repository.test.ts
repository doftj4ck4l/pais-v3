import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteMemoryStore } from "./memory.repository";

let store: SqliteMemoryStore;
let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  store = new SqliteMemoryStore(drizzle(sqlite) as never);
});

const note = (id: string, content: string, tags?: string[]) => ({
  id,
  ts: Date.now(),
  content,
  tags,
  source: "agent",
});

describe("memory scoping", () => {
  it("writes the workspace, not the user, as the scoping key", async () => {
    // The store takes its scope key positionally, so passing a workspace id to
    // a user-scoped store would still "work" and still be wrong. This reads the
    // column back to prove which one is being filled in.
    await store.append("ws1", note("m1", "anything"));
    const row = sqlite
      .query<{ workspace_id: string | null }, []>(`SELECT workspace_id FROM memory_notes`)
      .get();
    expect(row!.workspace_id).toBe("ws1");
  });

  it("recalls a note the workspace already had", async () => {
    // Seeded through the column directly: a store still filtering on user_id
    // finds nothing here, however it was called.
    sqlite.run(
      `INSERT INTO memory_notes (id, workspace_id, ts, content, tags, source)
       VALUES ('seed', 'ws1', 1, 'pre-existing note', NULL, 'user')`,
    );
    expect((await store.all("ws1")).map((e) => e.id)).toEqual(["seed"]);
    expect((await store.search("ws1", "pre-existing")).map((e) => e.id)).toEqual(["seed"]);
  });

  it("recalls a note in the workspace that wrote it", async () => {
    await store.append("ws1", note("m1", "the deploy key rotates monthly"));
    expect((await store.all("ws1")).map((e) => e.id)).toEqual(["m1"]);
  });

  it("never recalls another workspace's notes", async () => {
    // Memory belongs to the body of work, not the browser: a note taken while
    // researching one thing must not surface while working on another.
    await store.append("ws1", note("m1", "the deploy key rotates monthly"));
    expect(await store.all("ws2")).toEqual([]);
    expect(await store.search("ws2", "deploy")).toEqual([]);
  });

  it("searches content and tags within one workspace", async () => {
    await store.append("ws1", note("m1", "unrelated", ["billing"]));
    await store.append("ws1", note("m2", "the deploy key rotates monthly"));
    await store.append("ws2", note("m3", "deploy notes from elsewhere"));

    expect((await store.search("ws1", "deploy")).map((e) => e.id)).toEqual(["m2"]);
    expect((await store.search("ws1", "billing")).map((e) => e.id)).toEqual(["m1"]);
  });

  it("returns newest first", async () => {
    await store.append("ws1", { ...note("old", "first"), ts: 1 });
    await store.append("ws1", { ...note("new", "second"), ts: 2 });
    expect((await store.all("ws1")).map((e) => e.id)).toEqual(["new", "old"]);
  });
});
