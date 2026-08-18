import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { runRepository } from "./run.repository";

/**
 * `toolUsage` is what decides which MCP tools stay loaded in a model's context,
 * so a query that quietly returns nothing would not fail anything — it would
 * just make every run search from scratch forever. That is the failure these
 * cover: the join through `runs`, and reading a name out of the span's JSON.
 */

let sqlite: Database;
let db: any;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  db = drizzle(sqlite) as any;
});

let seq = 0;

function conversation(id: string, workspaceId: string) {
  sqlite
    .query(
      "insert into conversations (id, workspace_id, title, model_id, harness_id, created_at, updated_at) " +
        "values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, workspaceId, "t", "m", "pi", Date.now(), Date.now());
}

function run(id: string, conversationId: string, workspaceId: string) {
  sqlite
    .query(
      "insert into runs (id, conversation_id, workspace_id, harness_id, model_id, started_at, status) " +
        "values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, conversationId, workspaceId, "pi", "m", Date.now(), "done");
}

/** A `tool` span exactly as `pi.service` writes one. */
function toolSpan(conversationId: string, runId: string | null, name: string) {
  sqlite
    .query("insert into traces (id, conversation_id, run_id, step, fields, ts) values (?, ?, ?, ?, ?, ?)")
    .run(`t${seq++}`, conversationId, runId, "tool", JSON.stringify({ name, ms: 3, ok: true }), Date.now());
}

describe("runRepository.toolUsage", () => {
  beforeEach(() => {
    conversation("c1", "ws1");
    run("r1", "c1", "ws1");
  });

  it("counts calls per tool, most-used first", async () => {
    toolSpan("c1", "r1", "nextcloud__nc_webdav_read_file");
    for (let i = 0; i < 3; i++) toolSpan("c1", "r1", "nextcloud__nc_webdav_list_directory");
    toolSpan("c1", "r1", "bash");

    expect(await runRepository.toolUsage("ws1", 50, db)).toEqual([
      { name: "nextcloud__nc_webdav_list_directory", calls: 3 },
      { name: "nextcloud__nc_webdav_read_file", calls: 1 },
      { name: "bash", calls: 1 },
    ]);
  });

  it("counts across every run in the workspace, not just one", async () => {
    run("r2", "c1", "ws1");
    toolSpan("c1", "r1", "search");
    toolSpan("c1", "r2", "search");

    expect(await runRepository.toolUsage("ws1", 50, db)).toEqual([{ name: "search", calls: 2 }]);
  });

  it("does not leak another workspace's history", async () => {
    // The active tool set is built from this, so a leak would load one
    // workspace's tools into another's context window.
    conversation("c2", "ws2");
    run("r2", "c2", "ws2");
    toolSpan("c1", "r1", "mine");
    toolSpan("c2", "r2", "theirs");

    expect(await runRepository.toolUsage("ws1", 50, db)).toEqual([{ name: "mine", calls: 1 }]);
  });

  it("ignores spans that are not tool calls", async () => {
    sqlite
      .query("insert into traces (id, conversation_id, run_id, step, fields, ts) values (?, ?, ?, ?, ?, ?)")
      .run("t99", "c1", "r1", "llm.turn", JSON.stringify({ name: "not-a-tool" }), Date.now());
    toolSpan("c1", "r1", "real");

    expect(await runRepository.toolUsage("ws1", 50, db)).toEqual([{ name: "real", calls: 1 }]);
  });

  it("drops spans written before runs existed", async () => {
    // A null run_id cannot be attributed to a workspace at all, so it falls out
    // of the join rather than being counted against everyone.
    toolSpan("c1", null, "orphan");
    toolSpan("c1", "r1", "attributed");

    expect(await runRepository.toolUsage("ws1", 50, db)).toEqual([{ name: "attributed", calls: 1 }]);
  });

  it("drops a span whose fields carry no name", async () => {
    sqlite
      .query("insert into traces (id, conversation_id, run_id, step, fields, ts) values (?, ?, ?, ?, ?, ?)")
      .run("t98", "c1", "r1", "tool", "not json at all", Date.now());
    toolSpan("c1", "r1", "named");

    const usage = await runRepository.toolUsage("ws1", 50, db);
    expect(usage).toEqual([{ name: "named", calls: 1 }]);
  });

  it("honours the limit", async () => {
    for (const name of ["a", "b", "c"]) toolSpan("c1", "r1", name);
    expect(await runRepository.toolUsage("ws1", 2, db)).toHaveLength(2);
  });

  it("returns nothing for a workspace that has never run", async () => {
    expect(await runRepository.toolUsage("ws-new", 50, db)).toEqual([]);
  });
});

describe("runRepository platform views", () => {
  beforeEach(() => {
    sqlite.query("insert into users (id, created_at, display_name) values (?, ?, ?)").run("u1", Date.now(), "User One");
    sqlite.query("insert into users (id, created_at, display_name) values (?, ?, ?)").run("u2", Date.now(), null);
    sqlite.query("insert into workspaces (id, user_id, name, created_at) values (?, ?, ?, ?)").run("ws1", "u1", "One", Date.now());
    sqlite.query("insert into workspaces (id, user_id, name, created_at) values (?, ?, ?, ?)").run("ws2", "u2", "Two", Date.now());
    conversation("c1", "ws1");
    conversation("c2", "ws2");
    run("r1", "c1", "ws1");
    run("r2", "c2", "ws2");
  });

  it("lists runs across workspaces with owner attribution", async () => {
    const result = await runRepository.listPlatform({ limit: 20, offset: 0 }, db);

    expect(result.total).toBe(2);
    expect(result.runs.map((item) => item.userId).sort()).toEqual(["u1", "u2"]);
    expect(result.runs.find((item) => item.id === "r1")).toMatchObject({
      workspaceName: "One",
      displayName: "User One",
    });
  });

  it("filters the platform run ledger by user and status", async () => {
    sqlite.query("update runs set status = 'error' where id = 'r2'").run();

    const result = await runRepository.listPlatform({ limit: 20, offset: 0, userId: "u2", status: "error" }, db);
    expect(result.total).toBe(1);
    expect(result.runs[0]?.id).toBe("r2");
  });

  it("returns the exact filtered total when the requested page is empty", async () => {
    sqlite.query("update runs set status = 'error' where id = 'r2'").run();
    const result = await runRepository.listPlatform({ limit: 1, offset: 1, userId: "u2", status: "error" }, db);

    expect(result.runs).toEqual([]);
    expect(result.total).toBe(1);
  });

  it("reads any run by id for a super-admin controller", async () => {
    sqlite.query("insert into organizations (id, name, created_by_user_id, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("org1", "Acme", "u1", Date.now(), Date.now());
    sqlite.query("insert into organization_memberships (id, organization_id, user_id, email, joined_at) values (?, ?, ?, ?, ?)")
      .run("mem1", "org1", "u2", "u2@example.com", Date.now());

    expect(await runRepository.getPlatform("r2", db)).toMatchObject({
      id: "r2",
      userId: "u2",
      workspaceName: "Two",
      email: "u2@example.com",
      organizations: [{ id: "org1", name: "Acme" }],
    });
  });
});
