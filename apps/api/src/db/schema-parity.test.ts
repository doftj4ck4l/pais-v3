import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { applySchema, RESCOPED_TABLES } from "./client";
import { backfill, dropLegacyUserId, migrateSandboxDirs, rebuildSandboxes } from "./backfill";
import * as schema from "../models/schema";

/**
 * What the migrations build has to be what the models declare.
 *
 * The migrations are generated from `models/schema.ts`, so this cannot drift
 * on its own any more — which is exactly why the check is cheap to keep. What
 * it still catches is a migration edited by hand: 0000 is (it carries the
 * IF NOT EXISTS guards), 0001 is written by hand outright, and a later one may
 * be, since drizzle-kit cannot express everything SQLite can do.
 *
 * The failure that costs the most is silent. A column the Drizzle table
 * declares but the database does not have comes back from SQLite as the column
 * *name* rather than as an error, so the value looks plausible everywhere it
 * is displayed.
 */

/** Every Drizzle table in models/schema.ts, by SQL name. */
function drizzleTables(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    out.set(
      config.name,
      new Set(config.columns.map((c) => c.name)),
    );
  }
  return out;
}

/** Every table applySchema actually creates, by name, with its columns. */
function sqlTables(db: Database): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  for (const { name } of tables) {
    if (name.startsWith("sqlite_")) continue;
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${name})`).all();
    out.set(name, new Set(columns.map((c) => c.name)));
  }
  return out;
}

function fresh(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/** applySchema, then everything ensureSchema runs after it. */
function booted(): Database {
  const db = fresh();
  backfill(db);
  migrateSandboxDirs(db);
  dropLegacyUserId(db, RESCOPED_TABLES);
  rebuildSandboxes(db);
  return db;
}

describe("schema parity", () => {
  it("creates every table the ORM declares", () => {
    const sql = sqlTables(fresh());
    const missing = [...drizzleTables().keys()].filter((t) => !sql.has(t));
    expect(missing).toEqual([]);
  });

  it("creates every column the ORM declares", () => {
    // The dangerous direction. A CREATE TABLE that has fallen behind its
    // Drizzle definition does not fail at boot — it fails at the first query
    // that names the new column, by returning the name as the value.
    const sql = sqlTables(fresh());
    const missing: string[] = [];
    for (const [table, columns] of drizzleTables()) {
      const created = sql.get(table);
      if (!created) continue; // reported by the test above
      for (const column of columns) {
        if (!created.has(column)) missing.push(`${table}.${column}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("leaves no column behind that the ORM does not know about", () => {
    // The other direction, checked after the full boot sequence rather than
    // after applySchema alone: `user_id` is deliberately created and then
    // dropped, so that an upgraded database and a fresh one end the boot
    // identical. Checking too early would fail on a column that is meant to be
    // there for the length of one function call.
    const sql = sqlTables(booted());
    const drizzle = drizzleTables();
    const extra: string[] = [];
    for (const [table, columns] of sql) {
      const declared = drizzle.get(table);
      // FTS mirrors and their shadow tables are created by raw SQL and have no
      // Drizzle definition at all — they are searched through, never selected
      // from by the query builder.
      if (!declared) continue;
      for (const column of columns) {
        if (!declared.has(column)) extra.push(`${table}.${column}`);
      }
    }
    expect(extra).toEqual([]);
  });
});
