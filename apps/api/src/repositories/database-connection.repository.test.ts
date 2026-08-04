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

const conn = (over: Partial<Parameters<SqliteDatabaseConnectionStore["create"]>[0]> = {}) => ({
  id: "c1",
  userId: "u1",
  name: "sales",
  url: "postgres://reader:hunter2@db.example.com:5432/sales",
  displayHost: "db.example.com",
  displayDatabase: "sales",
  ...over,
});

let store: SqliteDatabaseConnectionStore;
beforeEach(() => {
  store = freshStore();
});

describe("SqliteDatabaseConnectionStore", () => {
  it("stores a connection and lists it back without the secret", async () => {
    await store.create(conn());
    const rows = await store.list("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("sales");
    expect(rows[0]!.displayHost).toBe("db.example.com");
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
  });

  it("does not store the connection string in plaintext", async () => {
    await store.create(conn());
    const raw = await store.debugRawSecret("c1");
    expect(raw).not.toContain("hunter2");
    expect(raw?.startsWith("v1.")).toBe(true);
  });

  it("resolves the decrypted url for its owner", async () => {
    await store.create(conn());
    expect(await store.resolveUrl("u1", "c1")).toContain("hunter2");
  });

  it("refuses to resolve a url for a different user", async () => {
    await store.create(conn());
    expect(await store.resolveUrl("someone-else", "c1")).toBeNull();
  });

  it("scopes listing by user", async () => {
    await store.create(conn());
    await store.create(conn({ id: "c2", userId: "u2", name: "other" }));
    expect(await store.list("u1")).toHaveLength(1);
  });

  it("finds a connection by name", async () => {
    await store.create(conn());
    expect((await store.findByName("u1", "sales"))?.id).toBe("c1");
    expect(await store.findByName("u1", "nope")).toBeNull();
  });

  it("rejects a duplicate name for the same user", async () => {
    await store.create(conn());
    await expect(store.create(conn({ id: "c9" }))).rejects.toThrow();
  });

  it("allows the same name for different users", async () => {
    await store.create(conn());
    await store.create(conn({ id: "c2", userId: "u2" }));
    expect(await store.list("u2")).toHaveLength(1);
  });

  it("records an introspection failure without discarding the connection", async () => {
    await store.create(conn());
    await store.markStatus("c1", "error", "could not connect: timeout");
    const row = (await store.list("u1"))[0]!;
    expect(row.status).toBe("error");
    expect(row.error).toBe("could not connect: timeout");
  });

  it("removes only the caller's connection", async () => {
    await store.create(conn());
    expect(await store.remove("someone-else", "c1")).toBe(false);
    expect(await store.remove("u1", "c1")).toBe(true);
    expect(await store.list("u1")).toHaveLength(0);
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
    await store.saveSnapshot("c1", "u1", snapshot);
  });

  it("records the table count and clears any prior error", async () => {
    const row = (await store.list("u1"))[0]!;
    expect(row.tableCount).toBe(2);
    expect(row.status).toBe("connected");
    expect(row.lastIntrospectedAt).toBeGreaterThan(0);
  });

  it("builds an inventory the system prompt can use", async () => {
    const inv = await store.inventory("u1");
    expect(inv).toHaveLength(1);
    expect(inv[0]!.name).toBe("sales");
    expect(inv[0]!.tables).toEqual(["orders", "refunds"]);
  });

  it("describes a table by its bare name", async () => {
    const detail = await store.describeTable("u1", "sales", "orders");
    expect(detail?.comment).toBe("Customer orders");
    expect(detail?.columns.map((c) => c.name)).toEqual(["id", "customer_id"]);
    expect(detail?.indexes).toHaveLength(1);
  });

  it("describes a table by its qualified name", async () => {
    expect((await store.describeTable("u1", "sales", "public.orders"))?.name).toBe("orders");
  });

  it("preserves the foreign key that makes a join correct", async () => {
    const detail = await store.describeTable("u1", "sales", "orders");
    const fk = detail!.columns.find((c) => c.name === "customer_id")!;
    expect(fk.fkTable).toBe("public.customers");
    expect(fk.fkColumn).toBe("id");
  });

  it("returns null for an unknown table", async () => {
    expect(await store.describeTable("u1", "sales", "ghost")).toBeNull();
  });

  it("does not describe a table belonging to another user", async () => {
    expect(await store.describeTable("u2", "sales", "orders")).toBeNull();
  });

  it("finds a table by a stemmed term", async () => {
    const hits = await store.searchSchema("u1", '"refund"', null, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.tableName === "refunds")).toBe(true);
  });

  it("finds a column and reports the table that holds it", async () => {
    const hits = await store.searchSchema("u1", '"customer_id"', null, 5);
    const hit = hits.find((h) => h.columnName === "customer_id");
    expect(hit?.tableName).toBe("orders");
  });

  it("scopes search to one connection when asked", async () => {
    expect(await store.searchSchema("u1", '"orders"', "nonexistent", 5)).toHaveLength(0);
  });

  it("replaces the previous snapshot rather than appending to it", async () => {
    await store.saveSnapshot("c1", "u1", [snapshot[0]!]);
    expect((await store.inventory("u1"))[0]!.tables).toEqual(["orders"]);
    expect(await store.searchSchema("u1", '"refund"', null, 5)).toHaveLength(0);
  });

  it("drops the snapshot and its search index when the connection is removed", async () => {
    await store.remove("u1", "c1");
    expect(await store.searchSchema("u1", '"orders"', null, 5)).toHaveLength(0);
  });
});
