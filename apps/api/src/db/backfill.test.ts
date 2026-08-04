import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "./client";
import { backfill, dropLegacyUserId, rebuildSandboxes } from "./backfill";

function seeded() {
  const db = new Database(":memory:");
  applySchema(db);
  db.run(`INSERT INTO users (id, created_at) VALUES ('u1', 1)`);
  db.run(
    `INSERT INTO conversations (id, user_id, title, model_id, harness_id, status, created_at, updated_at)
     VALUES ('c1','u1','t','m','h','done',1,1)`,
  );
  db.run(
    `INSERT INTO documents (id, user_id, title, bytes, pages, chunk_count, status, created_at)
     VALUES ('d1','u1','a.pdf',1,1,1,'indexed',1)`,
  );
  return db;
}

const columnsOf = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

describe("backfill", () => {
  it("gives each existing user one workspace and moves their rows into it", () => {
    const db = seeded();
    backfill(db);

    const ws = db
      .query<
        { id: string; user_id: string; name: string },
        []
      >(`SELECT id, user_id, name FROM workspaces`)
      .all();
    expect(ws).toHaveLength(1);
    expect(ws[0]!.user_id).toBe("u1");

    const conv = db
      .query<
        { workspace_id: string },
        []
      >(`SELECT workspace_id FROM conversations WHERE id = 'c1'`)
      .get();
    expect(conv!.workspace_id).toBe(ws[0]!.id);

    const doc = db
      .query<
        { workspace_id: string },
        []
      >(`SELECT workspace_id FROM documents WHERE id = 'd1'`)
      .get();
    expect(doc!.workspace_id).toBe(ws[0]!.id);
  });

  it("is idempotent — a second run creates no extra workspace", () => {
    const db = seeded();
    backfill(db);
    backfill(db);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM workspaces`).get()!.n,
    ).toBe(1);
  });

  it("does nothing on an empty database", () => {
    const db = new Database(":memory:");
    applySchema(db);
    backfill(db);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM workspaces`).get()!.n,
    ).toBe(0);
  });

  it("keeps two users' rows in separate workspaces", () => {
    const db = seeded();
    db.run(`INSERT INTO users (id, created_at) VALUES ('u2', 1)`);
    db.run(
      `INSERT INTO documents (id, user_id, title, bytes, pages, chunk_count, status, created_at)
       VALUES ('d2','u2','b.pdf',1,1,1,'indexed',1)`,
    );
    backfill(db);

    const [a, b] = db
      .query<
        { id: string; workspace_id: string },
        []
      >(`SELECT id, workspace_id FROM documents ORDER BY id`)
      .all();
    expect(a!.workspace_id).not.toBe(b!.workspace_id);
  });

  it("leaves already-scoped rows on their existing workspace", () => {
    const db = seeded();
    backfill(db);
    const first = db
      .query<
        { workspace_id: string },
        []
      >(`SELECT workspace_id FROM documents WHERE id = 'd1'`)
      .get()!.workspace_id;

    // A row that arrived after the first backfill must not be re-pointed.
    db.run(
      `INSERT INTO documents (id, user_id, workspace_id, title, bytes, pages, chunk_count, status, created_at)
       VALUES ('d9','u1','ws_other','c.pdf',1,1,1,'indexed',1)`,
    );
    backfill(db);

    expect(
      db
        .query<
          { workspace_id: string },
          []
        >(`SELECT workspace_id FROM documents WHERE id = 'd9'`)
        .get()!.workspace_id,
    ).toBe("ws_other");
    expect(
      db
        .query<
          { workspace_id: string },
          []
        >(`SELECT workspace_id FROM documents WHERE id = 'd1'`)
        .get()!.workspace_id,
    ).toBe(first);
  });
});

describe("rebuildSandboxes", () => {
  /** A database still shaped the way it was before workspaces existed. */
  function legacySandboxes() {
    const db = new Database(":memory:");
    applySchema(db);
    // applySchema builds the new shape, so the old one is recreated here to
    // stand in for a database written before the rekey.
    db.exec(`
      DROP TABLE sandboxes;
      CREATE TABLE sandboxes (
        user_id        TEXT PRIMARY KEY,
        container_id   TEXT,
        workspace_path TEXT NOT NULL,
        image          TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER NOT NULL
      );
      ALTER TABLE sandboxes ADD COLUMN workspace_id TEXT;
    `);
    return db;
  }

  it("rekeys the table to the workspace, keeping the row", () => {
    const db = legacySandboxes();
    db.run(
      `INSERT INTO sandboxes (user_id, workspace_id, container_id, workspace_path, image, created_at, last_used_at)
       VALUES ('u1', 'ws1', 'c1', '/root/ws1', 'img', 1, 2)`,
    );
    rebuildSandboxes(db);

    expect(columnsOf(db, "sandboxes")).not.toContain("user_id");
    const row = db
      .query<
        { workspace_id: string; container_id: string; workspace_path: string },
        []
      >(`SELECT workspace_id, container_id, workspace_path FROM sandboxes`)
      .get();
    expect(row!.workspace_id).toBe("ws1");
    expect(row!.container_id).toBe("c1");
    expect(row!.workspace_path).toBe("/root/ws1");
  });

  it("makes the workspace the primary key", () => {
    const db = legacySandboxes();
    db.run(
      `INSERT INTO sandboxes (user_id, workspace_id, container_id, workspace_path, image, created_at, last_used_at)
       VALUES ('u1', 'ws1', 'c1', '/root/ws1', 'img', 1, 2)`,
    );
    rebuildSandboxes(db);
    expect(() =>
      db.run(
        `INSERT INTO sandboxes (workspace_id, workspace_path, image, created_at, last_used_at)
         VALUES ('ws1', '/root/ws1', 'img', 1, 2)`,
      ),
    ).toThrow();
  });

  it("leaves an unplaced row alone rather than losing its directory", () => {
    const db = legacySandboxes();
    db.run(
      `INSERT INTO sandboxes (user_id, workspace_id, container_id, workspace_path, image, created_at, last_used_at)
       VALUES ('u1', NULL, 'c1', '/root/u1', 'img', 1, 2)`,
    );
    rebuildSandboxes(db);
    // Still the old shape, so the next boot can try again once it is placed.
    expect(columnsOf(db, "sandboxes")).toContain("user_id");
  });

  it("is idempotent — a second run is a no-op", () => {
    const db = legacySandboxes();
    db.run(
      `INSERT INTO sandboxes (user_id, workspace_id, container_id, workspace_path, image, created_at, last_used_at)
       VALUES ('u1', 'ws1', 'c1', '/root/ws1', 'img', 1, 2)`,
    );
    rebuildSandboxes(db);
    rebuildSandboxes(db);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM sandboxes`).get()!.n,
    ).toBe(1);
  });
});

describe("dropLegacyUserId", () => {
  it("removes user_id from the scoped tables once their rows are placed", () => {
    const db = seeded();
    backfill(db);
    dropLegacyUserId(db);

    for (const table of ["conversations", "documents", "chunks", "db_connections"]) {
      expect(columnsOf(db, table)).not.toContain("user_id");
      expect(columnsOf(db, table)).toContain("workspace_id");
    }
    // The ownership root keeps its user_id — that is the whole point of it.
    expect(columnsOf(db, "workspaces")).toContain("user_id");
  });

  it("refuses to drop while a row is still unscoped", () => {
    const db = seeded();
    // No backfill: d1 still has workspace_id IS NULL. Dropping user_id here
    // would strand it with no way to ever work out where it belongs.
    dropLegacyUserId(db);
    expect(columnsOf(db, "documents")).toContain("user_id");
  });

  it("is idempotent — a second run is a no-op", () => {
    const db = seeded();
    backfill(db);
    dropLegacyUserId(db);
    dropLegacyUserId(db);
    expect(columnsOf(db, "documents")).not.toContain("user_id");
  });

  it("leaves the data intact", () => {
    const db = seeded();
    backfill(db);
    dropLegacyUserId(db);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM documents`).get()!.n,
    ).toBe(1);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM conversations`).get()!.n,
    ).toBe(1);
  });

  it("replaces the connection-name uniqueness with a per-workspace one", () => {
    const db = seeded();
    backfill(db);
    dropLegacyUserId(db);

    const conn = (id: string, ws: string, name: string) =>
      db.run(
        `INSERT INTO db_connections (id, workspace_id, name, engine, secret, display_host, display_database, status, table_count, created_at)
         VALUES (?, ?, ?, 'postgres', 's', 'h', 'd', 'connected', 0, 1)`,
        [id, ws, name],
      );

    // The same name in two workspaces is the point of workspaces.
    conn("k1", "ws1", "prod");
    conn("k2", "ws2", "prod");
    // Twice in one workspace stays ambiguous to the agent, so it stays rejected.
    expect(() => conn("k3", "ws1", "prod")).toThrow();
  });
});
