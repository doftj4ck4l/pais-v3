import { Database } from "bun:sqlite";
import { applySchema } from "../client";
import { SCOPED_TABLES } from "../backfill";

/**
 * A database shaped the way one looked before workspaces existed.
 *
 * `backfill` and `dropLegacyUserId` exist to move such a database forward, so
 * their tests need one to move. It used to come for free: the hand-written DDL
 * still declared `user_id` on every scoped table, years after the models had
 * dropped it, purely so this shape kept appearing.
 *
 * Now that the schema is generated from `models/schema.ts`, the current schema
 * has no `user_id` — which is correct, and means the legacy shape has to be
 * asked for. That is the better arrangement: the column a migration exists to
 * remove belongs in the test for that migration, not in the DDL every fresh
 * database is created from.
 */
export function legacyDatabase(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  for (const table of SCOPED_TABLES) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
  }
  return db;
}
