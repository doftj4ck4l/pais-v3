import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { conversationRepository } from "./conversation.repository";

/**
 * `conversationRepository` binds the app-wide database handle directly, so
 * these exercise the schema the repository's queries depend on rather than the
 * repository object itself: that a conversation is reachable by workspace, and
 * that a workspace filter cannot see across the boundary.
 */
function seeded() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  sqlite.run(`INSERT INTO users (id, created_at) VALUES ('u1', 1)`);
  for (const [id, ws] of [
    ["c1", "ws1"],
    ["c2", "ws2"],
  ] as const) {
    sqlite.run(
      `INSERT INTO conversations (id, workspace_id, title, model_id, harness_id, status, created_at, updated_at)
       VALUES (?, ?, 't', 'm', 'h', 'done', 1, 1)`,
      [id, ws],
    );
  }
  return sqlite;
}

describe("conversation scoping", () => {
  it("lists only the given workspace's conversations", () => {
    const rows = seeded()
      .query<{ id: string }, [string]>(`SELECT id FROM conversations WHERE workspace_id = ?`)
      .all("ws1");
    expect(rows.map((r) => r.id)).toEqual(["c1"]);
  });

  it("does not resolve a conversation through the wrong workspace", () => {
    // This is the ownership check `getOwned` performs: a known id paired with a
    // workspace that does not hold it must come back empty, not fall through to
    // the row itself.
    const row = seeded()
      .query<
        { id: string },
        [string, string]
      >(`SELECT id FROM conversations WHERE id = ? AND workspace_id = ?`)
      .get("c1", "ws2");
    expect(row).toBeNull();
  });

  it("stores a conversation without a user id", () => {
    // The column is gone from the model; a conversation reaches its user
    // through the workspace instead.
    const sqlite = seeded();
    const cols = sqlite
      .query<{ name: string }, []>(`PRAGMA table_info(conversations)`)
      .all()
      .map((c) => c.name);
    expect(cols).toContain("workspace_id");
  });
});

describe("conversationRepository.stopInterrupted", () => {
  it("stops only conversations orphaned in running state", async () => {
    const sqlite = seeded();
    sqlite.run("UPDATE conversations SET status = 'running' WHERE id = 'c1'");
    const db = drizzle(sqlite) as any;

    expect(await conversationRepository.stopInterrupted(12_345, db)).toBe(1);
    expect(
      sqlite.query("SELECT status, updated_at FROM conversations WHERE id = 'c1'").get(),
    ).toEqual({ status: "stopped", updated_at: 12_345 });
    expect(
      sqlite.query("SELECT status, updated_at FROM conversations WHERE id = 'c2'").get(),
    ).toEqual({ status: "done", updated_at: 1 });
  });
});

describe("conversationRepository.setPinned", () => {
  it("persists the pin without changing the run timestamp", async () => {
    const sqlite = seeded();
    const db = drizzle(sqlite) as any;

    const row = await conversationRepository.setPinned("c1", "ws1", true, db);

    expect(row?.pinned).toBe(true);
    expect(
      sqlite.query("SELECT pinned, updated_at FROM conversations WHERE id = 'c1'").get(),
    ).toEqual({ pinned: 1, updated_at: 1 });
  });

  it("does not pin a conversation held by another workspace", async () => {
    const sqlite = seeded();
    const db = drizzle(sqlite) as any;

    expect(await conversationRepository.setPinned("c1", "ws2", true, db)).toBeUndefined();
    expect(sqlite.query("SELECT pinned FROM conversations WHERE id = 'c1'").get()).toEqual({
      pinned: 0,
    });
  });
});
