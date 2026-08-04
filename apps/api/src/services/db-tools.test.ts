import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteDatabaseConnectionStore } from "../repositories/database-connection.repository";
import type { QueryOutcome } from "./db/postgres.driver";
import type { SnapshotTable } from "./db/introspect.service";
import { createDatabaseTools } from "./db-tools";

/**
 * Exercises the three agent-facing database tools against a real SQLite-backed
 * store (schema/search metadata only — never a live Postgres) with `execute`
 * stubbed out. This is what proves, independent of the repository's own tests,
 * that a tool result never contains a raw connection string and that
 * `describe_table` truly never runs SQL.
 */

(env as { connectionSecret: string }).connectionSecret = "test-secret";

const snapshot: SnapshotTable[] = [
  {
    schemaName: "public", name: "orders", comment: "Customer orders", rowEstimate: 1200, indexes: [],
    columns: [
      { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
      { seq: 2, name: "customer_id", dataType: "integer", nullable: false, isPrimaryKey: false, fkTable: "public.customers", fkColumn: "id", comment: null },
    ],
  },
];

let store: SqliteDatabaseConnectionStore;
let lastSql: string | null;
let outcome: QueryOutcome;

const toolsFor = () =>
  createDatabaseTools("u1", store, async (_url, sql) => {
    lastSql = sql;
    return outcome;
  });

const tool = (name: string) => toolsFor().find((t) => t.name === name)!;
const textOf = (result: any) => result.content[0].text as string;

beforeEach(async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  store = new SqliteDatabaseConnectionStore(drizzle(sqlite) as any);
  await store.create({
    id: "c1", userId: "u1", name: "sales",
    url: "postgres://reader:hunter2@db.example.com:5432/sales",
    displayHost: "db.example.com", displayDatabase: "sales",
  });
  await store.saveSnapshot("c1", "u1", snapshot);
  lastSql = null;
  outcome = { ok: true, columns: ["count"], rows: [{ count: 3 }], truncated: false };
});

describe("createDatabaseTools", () => {
  it("exposes exactly search_schema, describe_table, and run_query", () => {
    expect(toolsFor().map((t) => t.name).sort()).toEqual([
      "describe_table", "run_query", "search_schema",
    ]);
  });

  it("describes a table with its types and foreign keys", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "orders" }));
    expect(out).toContain("customer_id");
    expect(out).toContain("integer");
    expect(out).toContain("public.customers.id");
  });

  it("never returns sample rows from describe_table", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "orders" }));
    expect(lastSql).toBeNull(); // it must not query the database at all
    expect(out.toLowerCase()).not.toContain("sample");
  });

  it("tells the agent which tables exist when it names an unknown one", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "ghost" }));
    expect(out).toContain("orders");
  });

  it("lists valid connection names when the agent names an unknown one", async () => {
    const out = textOf(await tool("run_query").execute("1", { connection: "nope", sql: "SELECT 1" }));
    expect(out).toContain("sales");
  });

  it("finds a table through search_schema", async () => {
    const out = textOf(await tool("search_schema").execute("1", { query: "orders" }));
    expect(out).toContain("orders");
  });

  it("reports no match rather than returning an empty result", async () => {
    const out = textOf(await tool("search_schema").execute("1", { query: "zzzznothing" }));
    expect(out.toLowerCase()).toContain("no schema");
  });

  it("runs a query and renders the rows", async () => {
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT count(*) FROM orders" }));
    expect(lastSql).toBe("SELECT count(*) FROM orders");
    expect(out).toContain("3");
  });

  it("returns a query error as text so the loop can retry", async () => {
    outcome = { ok: false, error: 'column "totl" does not exist' };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT totl FROM orders" }));
    expect(out).toContain("totl");
  });

  it("reports truncation so the agent aggregates instead of paginating", async () => {
    outcome = {
      ok: true, columns: ["id"],
      rows: Array.from({ length: 100 }, (_, i) => ({ id: i })), truncated: true,
    };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT id FROM orders" }));
    expect(out.toLowerCase()).toContain("more exist");
  });

  it("says so plainly when a query returns nothing", async () => {
    outcome = { ok: true, columns: [], rows: [], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT 1 WHERE false" }));
    expect(out.toLowerCase()).toContain("no rows");
  });

  it("never leaks the connection string into a tool result", async () => {
    outcome = { ok: false, error: "connection refused" };
    for (const t of toolsFor()) {
      const out = textOf(await t.execute("1", { connection: "sales", table: "orders", query: "orders", sql: "SELECT 1" }));
      expect(out).not.toContain("hunter2");
    }
  });
});

describe("describe_table with an ambiguous bare name", () => {
  beforeEach(async () => {
    // Two non-public schemas both holding a table named "orders" — the same
    // setup the repository's own tests use to exercise alternateSchemas.
    await store.saveSnapshot("c1", "u1", [
      {
        schemaName: "eu", name: "orders", comment: null, rowEstimate: 1, indexes: [],
        columns: [
          { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
        ],
      },
      {
        schemaName: "us", name: "orders", comment: null, rowEstimate: 1, indexes: [],
        columns: [
          { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
        ],
      },
    ]);
  });

  it("warns near the top of the output when the name is ambiguous, naming the other schema", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "orders" }));
    const warningLine = 'NOTE: "orders" is ambiguous — also exists in: us. Showing eu.orders. To describe a different one, qualify it, e.g. us.orders.';
    expect(out).toContain(warningLine);
    // Near the top: the warning must precede the resolved table header, not
    // trail after the column list where the agent could miss it.
    expect(out.indexOf(warningLine)).toBeLessThan(out.indexOf("eu.orders\n"));
  });

  it("omits the ambiguity warning once the name is schema-qualified", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "us.orders" }));
    expect(out.toLowerCase()).not.toContain("ambiguous");
  });
});
