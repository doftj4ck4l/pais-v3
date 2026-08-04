import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteDatabaseConnectionStore } from "./database-connection.repository";

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
