import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env";

/**
 * Every table that a workspace scopes. `sandboxes` is here too, but it is the
 * one table whose `user_id` is a primary key, so it cannot simply have the
 * column dropped — see `dropLegacyUserId`.
 */
export const SCOPED_TABLES = [
  "conversations",
  "documents",
  "chunks",
  "db_connections",
  "db_tables",
  "db_columns",
  "memory_notes",
  "sandboxes",
] as const;

export const columnsOf = (target: Database, table: string): string[] =>
  target
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

const hasColumn = (target: Database, table: string, column: string) =>
  columnsOf(target, table).includes(column);

/**
 * Move pre-workspace rows into one workspace per user.
 *
 * Runs on every boot and does nothing once every row is scoped, so it is safe
 * to leave in place: a database from before workspaces existed can be opened at
 * any point without a manual migration step. It never deletes — a user's
 * existing agents, documents and connections all land in their default
 * workspace rather than being orphaned.
 */
export function backfill(target: Database): void {
  // Once `dropLegacyUserId` has run there is no `user_id` left to read, which
  // is also proof there is nothing left to place.
  const placeable = SCOPED_TABLES.filter(
    (t) => hasColumn(target, t, "user_id") && hasColumn(target, t, "workspace_id"),
  );
  if (placeable.length === 0) return;

  const orphans = target
    .query<{ user_id: string }, []>(
      `SELECT DISTINCT user_id FROM (
         ${placeable
           .map((t) => `SELECT user_id FROM ${t} WHERE workspace_id IS NULL`)
           .join(" UNION ")}
       ) WHERE user_id IS NOT NULL`,
    )
    .all();

  for (const { user_id } of orphans) {
    const existing = target
      .query<{ id: string }, [string]>(
        `SELECT id FROM workspaces WHERE user_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(user_id);

    let workspaceId = existing?.id;
    if (!workspaceId) {
      workspaceId = `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      target.run(
        `INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`,
        [workspaceId, user_id, "Default", Date.now()],
      );
    }

    for (const table of placeable) {
      target.run(
        `UPDATE ${table} SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL`,
        [workspaceId, user_id],
      );
    }
  }
}

/**
 * Sandbox directories were named by user; they are named by workspace now.
 *
 * Renamed rather than recreated — a workspace's files are meant to outlive
 * everything, so losing them here would break the one promise the sandbox
 * makes. The stored `workspace_path` moves with the directory: `acquire`
 * prefers the recorded path, so leaving it behind would quietly keep mounting
 * the old location.
 */
export function migrateSandboxDirs(target: Database): void {
  if (!hasColumn(target, "sandboxes", "user_id")) return;

  const rows = target
    .query<{ user_id: string; workspace_id: string }, []>(
      `SELECT user_id, workspace_id FROM sandboxes
        WHERE workspace_id IS NOT NULL AND user_id IS NOT NULL`,
    )
    .all();

  for (const { user_id, workspace_id } of rows) {
    const from = path.join(env.sandboxRoot, user_id);
    const to = path.join(env.sandboxRoot, workspace_id);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    target.run(`UPDATE sandboxes SET workspace_path = ? WHERE user_id = ?`, [to, user_id]);
  }
}

/**
 * Rekey `sandboxes` from the user to the workspace.
 *
 * The other tables can simply drop `user_id`, but here it is the primary key,
 * which SQLite will not drop — so the table is rebuilt around the new key.
 * Runs after `migrateSandboxDirs`, which still needs the old column.
 */
export function rebuildSandboxes(target: Database): void {
  if (!hasColumn(target, "sandboxes", "user_id")) return;
  // A row that never got a workspace has nothing to be keyed by. That only
  // happens if backfill could not place it, in which case dropping it would
  // lose the path to a real directory — so it is left for the next boot.
  const unplaced = target
    .query<
      { one: number },
      []
    >(`SELECT 1 one FROM sandboxes WHERE workspace_id IS NULL LIMIT 1`)
    .get();
  if (unplaced) return;

  target.exec(`
    CREATE TABLE sandboxes_rekeyed (
      workspace_id   TEXT PRIMARY KEY,
      container_id   TEXT,
      workspace_path TEXT NOT NULL,
      image          TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      last_used_at   INTEGER NOT NULL
    );
    -- Ordered so that if two users ever shared a workspace, the most recently
    -- used row is the one that survives the primary key.
    INSERT OR REPLACE INTO sandboxes_rekeyed
      SELECT workspace_id, container_id, workspace_path, image, created_at, last_used_at
        FROM sandboxes ORDER BY last_used_at ASC;
    DROP TABLE sandboxes;
    ALTER TABLE sandboxes_rekeyed RENAME TO sandboxes;
    CREATE INDEX IF NOT EXISTS idx_sandboxes_last_used ON sandboxes (last_used_at);
  `);
}

/**
 * Retire the pre-workspace scoping key.
 *
 * `user_id` was `NOT NULL` on these tables, so leaving it in place would reject
 * every row written after the repositories stopped filling it in. It is dropped
 * rather than relaxed because nothing reads it once a table is re-scoped, and a
 * column that exists but is always NULL is an invitation to filter on it by
 * mistake.
 *
 * A table is only touched when all of its rows already carry a `workspace_id`.
 * Dropping the column while a row was still unplaced would strand that row with
 * no way to ever work out where it belonged.
 */
export function dropLegacyUserId(
  target: Database,
  tables: readonly string[] = SCOPED_TABLES.filter((t) => t !== "sandboxes"),
): void {
  for (const table of tables) {
    if (!hasColumn(target, table, "user_id")) continue;

    const unplaced = target
      .query<
        { one: number },
        []
      >(`SELECT 1 one FROM ${table} WHERE workspace_id IS NULL LIMIT 1`)
      .get();
    if (unplaced) continue;

    // SQLite refuses to drop a column an index is built on, so the indexes that
    // mention it go first. Read from sqlite_master rather than hardcoded, so a
    // later index on user_id cannot silently break the upgrade.
    const indexes = target
      .query<{ name: string; sql: string }, [string]>(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
      )
      .all(table)
      .filter((i) => /\buser_id\b/.test(i.sql));

    for (const { name } of indexes) target.exec(`DROP INDEX IF EXISTS "${name}"`);
    target.exec(`ALTER TABLE ${table} DROP COLUMN user_id`);
  }
}
