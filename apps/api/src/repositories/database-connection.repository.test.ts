import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteDatabaseConnectionStore } from "./database-connection.repository";
import type { SnapshotTable } from "../services/db/introspect.service";

/**
 * Runs against a real in-memory database built from the production schema
 * (via applySchema) rather than a mock, so the unique-name constraint, the
 * cascade deletes, and the encrypt/decrypt round trip are all exercised for
 * real — not asserted against a stand-in that could drift from production.
 */

(env as { connectionSecret: string }).connectionSecret = "test-secret";

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteDatabaseConnectionStore(drizzle(sqlite) as any);
}

const baseConfig = {
  engine: "postgresql" as const,
  host: "db.example.com",
  port: 5432,
  database: "sales",
  username: "reader",
  password: "hunter2",
  ssl: { mode: "disable" as const, ca: null, serverName: null },
};

const conn = (over: Partial<Parameters<SqliteDatabaseConnectionStore["create"]>[0]> = {}) => ({
  id: "c1",
  workspaceId: "ws1",
  name: "sales",
  ...over,
  config: { ...baseConfig, ...over.config },
});

let store: SqliteDatabaseConnectionStore;
beforeEach(() => {
  store = freshStore();
});

describe("SqliteDatabaseConnectionStore", () => {
  it("stores a connection and lists it back without the secret", async () => {
    await store.create(conn());
    const rows = await store.list("ws1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("sales");
    expect(rows[0]!.host).toBe("db.example.com");
    expect(rows[0]!.port).toBe(5432);
    expect(rows[0]!.username).toBe("reader");
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
    expect(JSON.stringify(rows[0])).not.toContain("postgres://");
  });

  it("does not store the connection string in plaintext", async () => {
    await store.create(conn());
    const raw = await store.debugRawSecret("c1");
    expect(raw).not.toContain("hunter2");
    expect(raw?.startsWith("v1.")).toBe(true);
  });

  it("resolves the decrypted structured config for its owner", async () => {
    await store.create(conn());
    expect(await store.resolveConfig("ws1", "c1")).toEqual(baseConfig);
  });

  it("preserves a MySQL engine and its default port through encrypted storage", async () => {
    const mysqlConfig = {
      ...baseConfig,
      engine: "mysql" as const,
      port: 3306,
      password: "mysql-test-secret",
    };
    await store.create(conn({ config: mysqlConfig }));
    expect((await store.list("ws1"))[0]).toMatchObject({ engine: "mysql", port: 3306 });
    expect(await store.resolveConfig("ws1", "c1")).toEqual(mysqlConfig);
    expect(JSON.stringify((await store.list("ws1"))[0])).not.toContain("mysql-test-secret");
  });

  it("preserves a SQL Server engine and port through encrypted storage", async () => {
    const sqlserverConfig = {
      ...baseConfig,
      engine: "sqlserver" as const,
      port: 1433,
      password: "sqlserver-test-secret",
      ssl: { mode: "require" as const, ca: null, serverName: null },
    };
    await store.create(conn({ config: sqlserverConfig }));
    expect((await store.list("ws1"))[0]).toMatchObject({ engine: "sqlserver", port: 1433 });
    expect(await store.resolveConfig("ws1", "c1")).toEqual(sqlserverConfig);
    expect(JSON.stringify((await store.list("ws1"))[0])).not.toContain("sqlserver-test-secret");
  });

  it("resolves public fields and private config together without mixing ownership", async () => {
    await store.create(conn());
    const resolved = await store.resolveConnection("ws1", "c1");
    expect(resolved?.row.name).toBe("sales");
    expect(JSON.stringify(resolved?.row)).not.toContain("hunter2");
    expect(resolved?.config.password).toBe("hunter2");
    expect(await store.resolveConnection("someone-else", "c1")).toBeNull();
  });

  it("refuses to resolve credentials for a different user", async () => {
    await store.create(conn());
    expect(await store.resolveConfig("someone-else", "c1")).toBeNull();
  });

  it("updates public fields while preserving encrypted response redaction", async () => {
    await store.create(conn());
    const config = { ...baseConfig, host: "10.35.180.238", password: "new-secret" };
    expect(await store.update("ws1", "c1", {
      name: "warehouse",
      config,
      status: "connected",
      error: null,
    })).toBe(true);
    const row = (await store.list("ws1"))[0]!;
    expect(row.name).toBe("warehouse");
    expect(row.host).toBe("10.35.180.238");
    expect(JSON.stringify(row)).not.toContain("new-secret");
    expect((await store.resolveConfig("ws1", "c1"))?.password).toBe("new-secret");
  });

  it("scopes listing by user", async () => {
    await store.create(conn());
    await store.create(conn({ id: "c2", workspaceId: "ws2", name: "other" }));
    expect(await store.list("ws1")).toHaveLength(1);
  });

  it("finds a connection by name", async () => {
    await store.create(conn());
    expect((await store.findByName("ws1", "sales"))?.id).toBe("c1");
    expect(await store.findByName("ws1", "nope")).toBeNull();
  });

  it("finds a public connection by owned id", async () => {
    await store.create(conn());
    expect((await store.findById("ws1", "c1"))?.name).toBe("sales");
    expect(await store.findById("someone-else", "c1")).toBeNull();
  });

  it("rejects a duplicate name for the same user", async () => {
    await store.create(conn());
    await expect(store.create(conn({ id: "c9" }))).rejects.toThrow();
  });

  it("allows the same name for different users", async () => {
    await store.create(conn());
    await store.create(conn({ id: "c2", workspaceId: "ws2" }));
    expect(await store.list("ws2")).toHaveLength(1);
  });

  it("records an introspection failure without discarding the connection", async () => {
    await store.create(conn());
    await store.markStatus("ws1", "c1", "error", "could not connect: timeout");
    const row = (await store.list("ws1"))[0]!;
    expect(row.status).toBe("error");
    expect(row.error).toBe("could not connect: timeout");
  });

  it("removes only the caller's connection", async () => {
    await store.create(conn());
    expect(await store.remove("someone-else", "c1")).toBe(false);
    expect(await store.remove("ws1", "c1")).toBe(true);
    expect(await store.list("ws1")).toHaveLength(0);
  });

  it("does nothing when markStatus is called with a mismatched workspaceId", async () => {
    await store.create(conn());
    await store.markStatus("mallory", "c1", "error", "attacker-supplied error");
    const row = (await store.list("ws1"))[0]!;
    // Still whatever `create()` left it as — untouched by the mismatched call.
    expect(row.status).toBe("connected");
    expect(row.error).toBeNull();
  });
});

const snapshot: SnapshotTable[] = [
  {
    schemaName: "public",
    name: "orders",
    comment: "Customer orders",
    rowEstimate: 1200,
    indexes: ["CREATE INDEX idx_orders_status ON public.orders USING btree (status)"],
    columns: [
      { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
      { seq: 2, name: "customer_id", dataType: "integer", nullable: false, isPrimaryKey: false, fkTable: "public.customers", fkColumn: "id", comment: null },
    ],
  },
  {
    schemaName: "public",
    name: "refunds",
    comment: null,
    rowEstimate: 8,
    indexes: [],
    columns: [
      { seq: 1, name: "reason", dataType: "text", nullable: true, isPrimaryKey: false, fkTable: null, fkColumn: null, comment: null },
    ],
  },
];

describe("snapshot", () => {
  beforeEach(async () => {
    await store.create(conn());
    await store.saveSnapshot("c1", "ws1", snapshot);
  });

  it("records the table count and clears any prior error", async () => {
    const row = (await store.list("ws1"))[0]!;
    expect(row.tableCount).toBe(2);
    expect(row.status).toBe("connected");
    expect(row.lastIntrospectedAt).toBeGreaterThan(0);
  });

  it("builds an inventory the system prompt can use", async () => {
    const inv = await store.inventory("ws1");
    expect(inv).toHaveLength(1);
    expect(inv[0]!.name).toBe("sales");
    expect(inv[0]!.tables).toEqual(["orders", "refunds"]);
  });

  it("describes a table by its bare name", async () => {
    const detail = await store.describeTable("ws1", "sales", "orders");
    expect(detail?.comment).toBe("Customer orders");
    expect(detail?.columns.map((c) => c.name)).toEqual(["id", "customer_id"]);
    expect(detail?.indexes).toHaveLength(1);
  });

  it("describes a table by its qualified name", async () => {
    expect((await store.describeTable("ws1", "sales", "public.orders"))?.name).toBe("orders");
  });

  it("preserves the foreign key that makes a join correct", async () => {
    const detail = await store.describeTable("ws1", "sales", "orders");
    const fk = detail!.columns.find((c) => c.name === "customer_id")!;
    expect(fk.fkTable).toBe("public.customers");
    expect(fk.fkColumn).toBe("id");
  });

  it("returns null for an unknown table", async () => {
    expect(await store.describeTable("ws1", "sales", "ghost")).toBeNull();
  });

  it("does not describe a table belonging to another user", async () => {
    expect(await store.describeTable("ws2", "sales", "orders")).toBeNull();
  });

  it("finds a table by a stemmed term", async () => {
    const hits = await store.searchSchema("ws1", '"refund"', null, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.tableName === "refunds")).toBe(true);
  });

  it("finds a column and reports the table that holds it", async () => {
    const hits = await store.searchSchema("ws1", '"customer_id"', null, 5);
    const hit = hits.find((h) => h.columnName === "customer_id");
    expect(hit?.tableName).toBe("orders");
  });

  it("scopes search to one connection when asked", async () => {
    expect(await store.searchSchema("ws1", '"orders"', "nonexistent", 5)).toHaveLength(0);
  });

  it("does not surface another workspace's tables", async () => {
    // db_schema_fts has no workspace_id of its own — it is filtered through the
    // connection it mirrors, so this is the case that proves the join is right.
    expect(await store.searchSchema("ws2", '"orders"', null, 5)).toHaveLength(0);
    expect(await store.searchSchema("ws2", '"refund"', null, 5)).toHaveLength(0);
  });

  it("lets two workspaces each hold a connection of the same name", async () => {
    // The old uniqueness was per user, which would have rejected this.
    await store.create(conn({ id: "c9", workspaceId: "ws2", name: "sales" }));
    expect((await store.findByName("ws2", "sales"))?.id).toBe("c9");
    expect((await store.findByName("ws1", "sales"))?.id).toBe("c1");
  });

  it("replaces the previous snapshot rather than appending to it", async () => {
    await store.saveSnapshot("c1", "ws1", [snapshot[0]!]);
    expect((await store.inventory("ws1"))[0]!.tables).toEqual(["orders"]);
    expect(await store.searchSchema("ws1", '"refund"', null, 5)).toHaveLength(0);
  });

  it("drops the snapshot and its search index when the connection is removed", async () => {
    await store.remove("ws1", "c1");
    expect(await store.searchSchema("ws1", '"orders"', null, 5)).toHaveLength(0);
  });

  it("stops describing and searching a snapshot once the connection errors", async () => {
    // inventory() already excludes a non-connected connection; describeTable
    // and searchSchema must match, or a re-introspection failure leaves a
    // stale — possibly wrong — snapshot fully queryable by name.
    await store.markStatus("ws1", "c1", "error", "could not connect: timeout");
    expect(await store.describeTable("ws1", "sales", "orders")).toBeNull();
    expect(await store.searchSchema("ws1", '"orders"', null, 5)).toHaveLength(0);
  });

  it("does nothing when saveSnapshot is called with a mismatched workspaceId", async () => {
    // A single-table snapshot from an attacker-controlled call. If any part
    // of saveSnapshot ran unscoped, this would either replace the owner's
    // two-table snapshot with this one, or wipe the FTS index it depends on
    // while leaving the two `db_tables` rows behind — a partial, worse-than-
    // either failure. Neither may happen: the whole call must be a no-op.
    await store.saveSnapshot("c1", "mallory", [snapshot[1]!]);

    const row = (await store.list("ws1"))[0]!;
    expect(row.tableCount).toBe(2);

    const inv = await store.inventory("ws1");
    expect(inv[0]!.tables).toEqual(["orders", "refunds"]);
    expect(await store.searchSchema("ws1", '"refund"', null, 5)).not.toHaveLength(0);
  });
});

describe("bare-name resolution across non-public schemas", () => {
  beforeEach(async () => {
    await store.create(conn());
    // Two non-public schemas both holding a table named "orders": the
    // `public`-first tiebreaker in describeTable does not apply, so without a
    // secondary sort key SQLite could return either one nondeterministically.
    await store.saveSnapshot("c1", "ws1", [
      {
        schemaName: "eu",
        name: "orders",
        comment: null,
        rowEstimate: 1,
        indexes: [],
        columns: [
          { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
        ],
      },
      {
        schemaName: "us",
        name: "orders",
        comment: null,
        rowEstimate: 1,
        indexes: [],
        columns: [
          { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
        ],
      },
    ]);
  });

  it("resolves a bare ambiguous name deterministically and reports the alternate schema", async () => {
    const detail = await store.describeTable("ws1", "sales", "orders");
    expect(detail?.schemaName).toBe("eu"); // alphabetically first among the tied candidates
    expect(detail?.alternateSchemas).toEqual(["us"]);
  });

  it("reports no alternates once the name is qualified", async () => {
    const detail = await store.describeTable("ws1", "sales", "us.orders");
    expect(detail?.schemaName).toBe("us");
    expect(detail?.alternateSchemas).toEqual([]);
  });
});
