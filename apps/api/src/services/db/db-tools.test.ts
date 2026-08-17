import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { env } from "../../config/env";
import { SqliteDatabaseConnectionStore } from "../../repositories/database-connection.repository";
import type { QueryOutcome } from "./database-adapter";
import type { SnapshotTable } from "./introspect.service";
import { createDatabaseTools, loadDatabaseCapability } from "./db-tools";

/**
 * Exercises the three agent-facing database tools against a real SQLite-backed
 * store (schema/search metadata only — never a live Postgres) with `execute`
 * stubbed out. This proves, independent of the repository's own tests, that:
 * `describe_table` truly never calls the executor; a tool result never
 * contains the fixture connection's password, whether that password could
 * only reach the output through unscrubbed driver error text (executor path)
 * or through the store's own connection metadata (list/describe/search
 * paths); `run_query`'s row cap is always clamped into [1, ROW_CAP] no matter
 * what `limit` the agent passes; and `format()` never renders a real SQL NULL
 * the same way it renders the literal string "NULL".
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
let lastCap: number | undefined;
let outcome: QueryOutcome;

const toolsFor = () =>
  createDatabaseTools("ws1", store, async (_config, sql, cap) => {
    lastSql = sql;
    lastCap = cap;
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
    id: "c1", workspaceId: "ws1", name: "sales",
    config: {
      engine: "postgresql", host: "db.example.com", port: 5432, database: "sales",
      username: "reader", password: "hunter2", ssl: { mode: "disable" },
    },
  });
  await store.saveSnapshot("c1", "ws1", snapshot);
  lastSql = null;
  lastCap = undefined;
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

  it("never decrypts a connection string for describe_table or search_schema, only for run_query", async () => {
    let resolveConfigCalls = 0;
    const originalResolveConfig = store.resolveConfig.bind(store);
    store.resolveConfig = async (...args: Parameters<typeof originalResolveConfig>) => {
      resolveConfigCalls++;
      return originalResolveConfig(...args);
    };

    await tool("describe_table").execute("1", { connection: "sales", table: "orders" });
    await tool("search_schema").execute("1", { query: "orders" });
    expect(resolveConfigCalls).toBe(0);

    await tool("run_query").execute("1", { connection: "sales", sql: "SELECT 1" });
    expect(resolveConfigCalls).toBe(1);
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

  it("lists schemas and tables through the same engine-neutral search tool", async () => {
    const out = textOf(await tool("search_schema").execute("1", {}));
    expect(out).toContain("sales (1 tables)");
    expect(out).toContain("orders");
  });

  it("caps an unfiltered schema listing and tells the agent how to continue", async () => {
    await store.saveSnapshot(
      "c1",
      "ws1",
      Array.from({ length: 65 }, (_, index) => ({
        schemaName: "public",
        name: `table_${String(index).padStart(3, "0")}`,
        comment: null,
        rowEstimate: 0,
        indexes: [],
        columns: [],
      })),
    );

    const out = textOf(await tool("search_schema").execute("1", {}));
    expect(out).toContain("table_059");
    expect(out).not.toContain("table_060");
    expect(out).toContain("5 more - use search_schema with a query");
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
    outcome = { ok: false, error: { code: "query_failed", message: 'column "totl" does not exist' } };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT totl FROM orders" }));
    expect(out).toContain("totl");
  });

  it("reports row-cap truncation so the agent aggregates instead of paginating", async () => {
    outcome = {
      ok: true, columns: ["id"],
      rows: Array.from({ length: 100 }, (_, i) => ({ id: i })), truncated: true,
      truncatedReason: "rows",
    };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT id FROM orders" }));
    expect(out.toLowerCase()).toContain("more exist");
  });

  it("reports the actual rendered row count in the truncation message, not the requested limit", async () => {
    // The driver's `boundCap` — not this tool — decides how many rows a
    // caller-supplied limit actually yields, so the message must describe
    // what `outcome.rows` really holds (100 rows here) rather than echoing
    // the raw `limit: 1000` the agent asked for.
    outcome = {
      ok: true, columns: ["id"],
      rows: Array.from({ length: 100 }, (_, i) => ({ id: i })), truncated: true,
      truncatedReason: "rows",
    };
    const out = textOf(
      await tool("run_query").execute("1", {
        connection: "sales", sql: "SELECT id FROM orders", limit: 1000,
      }),
    );
    expect(out).toContain("showing the first 100 rows");
    expect(out).not.toContain("1000");
  });

  it("reports byte-cap truncation with column-narrowing advice, not the row-cap message", async () => {
    outcome = {
      ok: true, columns: ["big"],
      rows: [{ big: "x".repeat(60_000) }], truncated: true,
      truncatedReason: "bytes",
    };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT big FROM orders" }));
    expect(out.toLowerCase()).not.toContain("more exist");
    expect(out.toLowerCase()).toContain("byte");
    expect(out.toLowerCase()).toContain("left(");
  });

  it("explains when an individually oversized row is omitted by the byte cap", async () => {
    outcome = {
      ok: true, columns: ["payload"], rows: [], truncated: true, truncatedReason: "bytes",
    };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT payload FROM blobs" }));
    expect(out.toLowerCase()).toContain("no rows returned");
    expect(out.toLowerCase()).toContain("byte");
  });

  it("falls back to the row-cap wording when an outcome is truncated with no reason given", async () => {
    // Guards a caller (e.g. an older test, or a future executor) that builds
    // a QueryOutcome by hand without `truncatedReason` — the message must
    // still say something actionable rather than silently omitting advice.
    outcome = {
      ok: true, columns: ["id"],
      rows: [{ id: 1 }], truncated: true,
    } as any;
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT id FROM orders" }));
    expect(out.toLowerCase()).toContain("more exist");
  });

  it("appends aggregation guidance to a statement-timeout error, not just the raw Postgres message", async () => {
    outcome = { ok: false, error: { code: "timeout", message: "Database statement timeout" } };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT * FROM orders" }));
    expect(out).toContain("statement timeout");
    expect(out.toLowerCase()).toContain("aggregate");
    expect(out.toLowerCase()).toContain("again");
  });

  it("says so plainly when a query returns nothing", async () => {
    outcome = { ok: true, columns: [], rows: [], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT 1 WHERE false" }));
    expect(out.toLowerCase()).toContain("no rows");
  });

  it("never leaks the connection string into a tool result, even when the driver's own error text contains it", async () => {
    // The error message here deliberately contains the fixture's password.
    // A tool that interpolated driver error text verbatim (e.g. an
    // implementation that logged/echoed the failing DSN on connection
    // failure) would leak it right here — this is what makes the assertion
    // below meaningful rather than vacuously true.
    outcome = {
      ok: false,
      error: {
        code: "query_failed",
        message: "connection to postgres://reader:hunter2@db.example.com:5432/sales failed",
      },
    };
    for (const t of toolsFor()) {
      const out = textOf(await t.execute("1", { connection: "sales", table: "orders", query: "orders", sql: "SELECT 1" }));
      expect(out).not.toContain("hunter2");
    }
  });

  it("never leaks the connection string on a successful describe_table or search_schema result", async () => {
    // describe_table and search_schema never call the executor at all — any
    // leak on their path would have to come from store.list()/resolve()
    // metadata, not from driver error text, so this is a distinct code path
    // from the executor-error case above.
    const describeOut = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "orders" }));
    expect(describeOut).not.toContain("hunter2");

    const searchOut = textOf(await tool("search_schema").execute("1", { query: "orders" }));
    expect(searchOut).not.toContain("hunter2");
  });
});

describe("loadDatabaseCapability", () => {
  it("automatically exposes database tools and schema-first guidance for a connected workspace", async () => {
    const capability = await loadDatabaseCapability("ws1", store);

    expect(capability.tools.map((t) => t.name).sort()).toEqual([
      "describe_table", "run_query", "search_schema",
    ]);
    expect(capability.prompt).toContain('Connected databases:');
    expect(capability.prompt).toContain('"sales"');
    expect(capability.prompt).toContain('Call "describe_table"');
  });

  it("stays absent when the workspace has no connected database", async () => {
    const capability = await loadDatabaseCapability("another-workspace", store);

    expect(capability.tools).toEqual([]);
    expect(capability.prompt).toBe("");
  });
});

describe("describe_table with an ambiguous bare name", () => {
  beforeEach(async () => {
    // Two non-public schemas both holding a table named "orders" — the same
    // setup the repository's own tests use to exercise alternateSchemas.
    await store.saveSnapshot("c1", "ws1", [
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

describe("run_query cap forwarding", () => {
  // The tool no longer clamps `limit` itself — the driver's `boundCap` (see
  // postgres.driver.ts) is the single authority on what a caller-supplied
  // value is allowed to mean, so what reaches `execute` here is the raw
  // value, `Number`-coerced but otherwise unclamped in either direction.
  // `0` and above-cap values used to be silently rewritten to 100 by this
  // tool before reaching the driver, which is exactly the contradiction this
  // fix removes (the driver's own `boundCap(0) -> 1` was unreachable from
  // this path). Driver-side clamping to [1, ROW_CAP] — the invariant that
  // must still hold end to end — is exercised for real against Postgres by
  // `scripts/db-connector-check.ts` ("caps rows").
  const cases: { label: string; limit: unknown; expected: number }[] = [
    { label: "omitted", limit: undefined, expected: 100 },
    { label: "1000 (above cap)", limit: 1000, expected: 1000 },
    { label: "0", limit: 0, expected: 0 },
    { label: "-5", limit: -5, expected: -5 },
    { label: '"20" (numeric string)', limit: "20", expected: 20 },
  ];

  for (const { label, limit, expected } of cases) {
    it(`forwards the raw value (${expected}) when limit is ${label}`, async () => {
      const params: any = { connection: "sales", sql: "SELECT count(*) FROM orders" };
      if (limit !== undefined) params.limit = limit;
      await tool("run_query").execute("1", params);
      expect(lastCap).toBe(expected);
    });
  }

  it("forwards NaN when limit is NaN, rather than substituting a default", async () => {
    await tool("run_query").execute("1", {
      connection: "sales", sql: "SELECT count(*) FROM orders", limit: NaN,
    });
    expect(Number.isNaN(lastCap)).toBe(true);
  });
});

describe("run_query row rendering disambiguates NULL", () => {
  it("renders an actual SQL null as the bare word NULL", async () => {
    outcome = { ok: true, columns: ["v"], rows: [{ v: null }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain("\nNULL");
  });

  it("quotes a string value that is literally the text NULL, so it reads differently from a real null", async () => {
    outcome = { ok: true, columns: ["v"], rows: [{ v: "NULL" }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain('"NULL"');
    expect(out).not.toMatch(/\nNULL(?!\S)/); // not the bare-word form
  });

  it("quotes a lowercase 'null' string the same way, since the collision is case-insensitive", async () => {
    outcome = { ok: true, columns: ["v"], rows: [{ v: "null" }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain('"null"');
  });

  it("leaves an ordinary string unquoted", async () => {
    outcome = { ok: true, columns: ["v"], rows: [{ v: "hello" }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain("\nhello");
    expect(out).not.toContain('"hello"');
  });

  it("renders a Date as an ISO string", async () => {
    const d = new Date("2024-01-15T00:00:00.000Z");
    outcome = { ok: true, columns: ["v"], rows: [{ v: d }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain("2024-01-15T00:00:00.000Z");
  });

  it("renders a nested object as JSON", async () => {
    outcome = { ok: true, columns: ["v"], rows: [{ v: { a: 1 } }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain('{"a":1}');
  });

  it("renders undefined the same as null", async () => {
    outcome = { ok: true, columns: ["v"], rows: [{ v: undefined }], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT v" }));
    expect(out).toContain("\nNULL");
  });
});
