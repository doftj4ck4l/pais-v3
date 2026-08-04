import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteWorkspaceRegistry } from "./workspace-registry.repository";

let registry: SqliteWorkspaceRegistry;
let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  registry = new SqliteWorkspaceRegistry(drizzle(sqlite) as never);
});

const countOf = (table: string, where = "1=1") =>
  sqlite.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get()!.n;

describe("workspace registry", () => {
  it("creates and lists a workspace", async () => {
    const created = await registry.create("u1", "Research");
    expect(created.name).toBe("Research");
    expect(await registry.list("u1")).toHaveLength(1);
  });

  it("writes the user row, since nothing else does now", async () => {
    await registry.create("u1", "Research");
    await registry.create("u1", "Second");
    // Idempotent: a second workspace for the same user must not collide.
    expect(countOf("users")).toBe(1);
  });

  it("keeps users apart", async () => {
    await registry.create("u1", "Mine");
    expect(await registry.list("u2")).toEqual([]);
  });

  it("refuses to return another user's workspace", async () => {
    const mine = await registry.create("u1", "Mine");
    expect(await registry.getOwned(mine.id, "u2")).toBeUndefined();
  });

  it("falls back to a placeholder name when given blank", async () => {
    expect((await registry.create("u1", "   ")).name).toBe("Untitled");
  });

  it("resolve creates a default when the user has none", async () => {
    const resolved = await registry.resolve("u1");
    expect(resolved.name).toBe("Default");
    expect(await registry.list("u1")).toHaveLength(1);
  });

  it("resolve returns the requested workspace when it is owned", async () => {
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    expect((await registry.resolve("u1", a.id)).id).toBe(a.id);
  });

  it("resolve falls back to the user's first workspace for an unowned id", async () => {
    const mine = await registry.create("u1", "Mine");
    const theirs = await registry.create("u2", "Theirs");
    // A forged or stale id must not reach into another user's data.
    expect((await registry.resolve("u1", theirs.id)).id).toBe(mine.id);
  });

  it("renames only its owner's workspace", async () => {
    const mine = await registry.create("u1", "Old");
    expect(await registry.rename(mine.id, "u2", "Hacked")).toBe(false);
    expect(await registry.rename(mine.id, "u1", "New")).toBe(true);
    expect((await registry.list("u1"))[0]!.name).toBe("New");
  });

  it("refuses to remove the last workspace", async () => {
    const only = await registry.create("u1", "Only");
    // There must always be somewhere for a run to go.
    expect(await registry.remove(only.id, "u1")).toBe(false);
  });

  it("refuses to remove another user's workspace", async () => {
    const mine = await registry.create("u1", "Mine");
    await registry.create("u1", "Second");
    expect(await registry.remove(mine.id, "u2")).toBe(false);
    expect(await registry.list("u1")).toHaveLength(2);
  });

  it("removes a workspace when another remains", async () => {
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    expect(await registry.remove(a.id, "u1")).toBe(true);
    expect(await registry.list("u1")).toHaveLength(1);
  });

  it("takes the workspace's rows with it", async () => {
    // Scoped tables have no foreign key to workspaces, so a row left behind
    // would still match a search while being unreachable from the UI.
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    sqlite.run(
      `INSERT INTO documents (id, workspace_id, title, bytes, pages, chunk_count, status, created_at)
       VALUES ('d1', ?, 'a.pdf', 1, 1, 1, 'indexed', 1)`,
      [a.id],
    );

    await registry.remove(a.id, "u1");
    expect(countOf("documents")).toBe(0);
  });

  it("clears the FTS mirrors, which no foreign key would reach", async () => {
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");

    sqlite.run(
      `INSERT INTO documents (id, workspace_id, title, bytes, pages, chunk_count, status, created_at)
       VALUES ('d1', ?, 'a.pdf', 1, 1, 1, 'indexed', 1)`,
      [a.id],
    );
    sqlite.run(
      `INSERT INTO chunks (id, document_id, workspace_id, seq, page, text)
       VALUES ('ch1', 'd1', ?, 0, 1, 'enterprise refund window')`,
      [a.id],
    );
    sqlite.run(
      `INSERT INTO chunks_fts (text, chunk_id, document_id)
       VALUES ('enterprise refund window', 'ch1', 'd1')`,
    );
    sqlite.run(
      `INSERT INTO db_connections (id, workspace_id, name, engine, secret, display_host, display_database, status, table_count, created_at)
       VALUES ('k1', ?, 'prod', 'postgres', 's', 'h', 'd', 'connected', 0, 1)`,
      [a.id],
    );
    sqlite.run(
      `INSERT INTO db_schema_fts (text, object_id, connection_id, kind)
       VALUES ('orders', 'k1:public.orders', 'k1', 'table')`,
    );

    await registry.remove(a.id, "u1");

    // Both mirrors are FTS5 virtual tables: nothing cascades into them, so a
    // stale row would keep answering searches for a workspace that is gone.
    expect(countOf("chunks_fts")).toBe(0);
    expect(countOf("db_schema_fts")).toBe(0);
    expect(countOf("chunks")).toBe(0);
    expect(countOf("db_connections")).toBe(0);
  });

  it("leaves another workspace's rows untouched", async () => {
    const a = await registry.create("u1", "A");
    const b = await registry.create("u1", "B");
    for (const [id, ws] of [
      ["d1", a.id],
      ["d2", b.id],
    ] as const) {
      sqlite.run(
        `INSERT INTO documents (id, workspace_id, title, bytes, pages, chunk_count, status, created_at)
         VALUES (?, ?, 'a.pdf', 1, 1, 1, 'indexed', 1)`,
        [id, ws],
      );
    }

    await registry.remove(a.id, "u1");
    expect(countOf("documents")).toBe(1);
    expect(countOf("documents", `id = 'd2'`)).toBe(1);
  });

  it("takes the conversation's transcript with it", async () => {
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    sqlite.run(
      `INSERT INTO conversations (id, user_id, workspace_id, title, model_id, harness_id, status, created_at, updated_at)
       VALUES ('c1', 'u1', ?, 't', 'm', 'h', 'done', 1, 1)`,
      [a.id],
    );
    sqlite.run(
      `INSERT INTO messages (id, conversation_id, kind, seq, text, ts) VALUES ('m1','c1','user',0,'hi',1)`,
    );
    sqlite.run(
      `INSERT INTO traces (id, conversation_id, step, fields, ts) VALUES ('t1','c1','start',NULL,1)`,
    );

    await registry.remove(a.id, "u1");
    expect(countOf("conversations")).toBe(0);
    expect(countOf("messages")).toBe(0);
    expect(countOf("traces")).toBe(0);
  });
});
