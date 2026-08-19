import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
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
  it("keeps the deployed organization migration identity stable", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string; when: number }> };

    expect(journal.entries.find(({ tag }) => tag === "0007_fearless_multiple_man")?.when).toBe(
      1_786_953_545_492,
    );
  });

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

  it("creates the global activity range indexes", () => {
    const indexes = fresh()
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master " +
          "WHERE type = 'index' AND name IN ('idx_conversations_created', 'idx_runs_started') " +
          "ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    expect(indexes).toEqual(["idx_conversations_created", "idx_runs_started"]);
  });

  it("migrates historical runs to cumulative input-token accounting", () => {
    const database = fresh();
    database
      .query(
        "INSERT INTO runs " +
          "(id, conversation_id, harness_id, model_id, started_at, status, tokens_in) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-run", "legacy-conversation", "pi", "model", 1, "done", 180);
    const insertTrace = database.query(
      "INSERT INTO traces (id, conversation_id, run_id, step, fields, ts) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertTrace.run(
      "legacy-trace-1",
      "legacy-conversation",
      "legacy-run",
      "context.usage",
      JSON.stringify({ used: 120, output: 15 }),
      2,
    );
    insertTrace.run(
      "legacy-trace-2",
      "legacy-conversation",
      "legacy-run",
      "context.usage",
      JSON.stringify({ used: 180, output: 25 }),
      3,
    );
    insertTrace.run(
      "legacy-trace-malformed",
      "legacy-conversation",
      "legacy-run",
      "context.usage",
      "not-json",
      4,
    );

    const migration = fs.readFileSync(
      path.resolve(import.meta.dir, "../../drizzle/0008_same_shinobi_shaw.sql"),
      "utf8",
    );
    const backfillStatement = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.startsWith("UPDATE `runs`"));
    expect(backfillStatement).toBeDefined();
    database.exec(backfillStatement!);

    const row = database
      .query<{ tokensIn: number }, []>(
        "SELECT tokens_in AS tokensIn FROM runs WHERE id = 'legacy-run'",
      )
      .get();
    expect(row?.tokensIn).toBe(300);
  });

  it("preserves populated database inventories while upgrading through the agent migration", () => {
    const database = fresh();

    // Recreate the schema boundary before 0009, then apply its real SQL in the
    // same transaction shape used by Drizzle. Inside a transaction SQLite
    // ignores attempts to turn foreign-key enforcement off.
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("DROP TABLE agent_definitions");

    database
      .query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("workspace-before-agent", "owner", "Existing workspace", 1);
    database
      .query(
        "INSERT INTO db_connections " +
          "(id, workspace_id, name, secret, display_host, display_database, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "connection-before-agent",
        "workspace-before-agent",
        "Existing database",
        "encrypted",
        "db.internal",
        "production",
        2,
      );
    database
      .query(
        "INSERT INTO db_tables " +
          "(id, connection_id, workspace_id, schema_name, name) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "table-before-agent",
        "connection-before-agent",
        "workspace-before-agent",
        "public",
        "customers",
      );
    database
      .query(
        "INSERT INTO db_columns " +
          "(id, table_id, connection_id, workspace_id, seq, name, data_type, nullable, is_primary_key) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "column-before-agent",
        "table-before-agent",
        "connection-before-agent",
        "workspace-before-agent",
        0,
        "id",
        "uuid",
        0,
        1,
      );

    const migration = fs.readFileSync(
      path.resolve(import.meta.dir, "../../drizzle/0009_clammy_jackpot.sql"),
      "utf8",
    );
    database.transaction(() => {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }
    })();

    expect(
      database
        .query<{ id: string }, []>("SELECT id FROM db_connections")
        .all()
        .map(({ id }) => id),
    ).toEqual(["connection-before-agent"]);
    expect(
      database
        .query<{ id: string }, []>("SELECT id FROM db_tables")
        .all()
        .map(({ id }) => id),
    ).toEqual(["table-before-agent"]);
    expect(
      database
        .query<{ id: string }, []>("SELECT id FROM db_columns")
        .all()
        .map(({ id }) => id),
    ).toEqual(["column-before-agent"]);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_definitions'",
        )
        .get()?.name,
    ).toBe("agent_definitions");
  });

  it("keeps the custom-CA default stable across the agent migration metadata", () => {
    const snapshot = (name: string) =>
      JSON.parse(
        fs.readFileSync(path.resolve(import.meta.dir, `../../drizzle/meta/${name}`), "utf8"),
      ) as {
        tables: {
          db_connections: { columns: { has_custom_ca: { default: unknown } } };
        };
      };

    expect(snapshot("0009_snapshot.json").tables.db_connections.columns.has_custom_ca.default).toBe(
      snapshot("0008_snapshot.json").tables.db_connections.columns.has_custom_ca.default,
    );
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
