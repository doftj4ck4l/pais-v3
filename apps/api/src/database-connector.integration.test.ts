import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { env } from "./config/env";

let createApp: typeof import("./app").createApp;
let connector: typeof import("./services/db/database-connector.service").databaseConnector;
let store: typeof import("./repositories/database-connection.repository").databaseConnectionStore;
const mocks: { mockRestore(): void }[] = [];

const headers = (user: string) => ({
  "x-authentik-uid": user,
  "content-type": "application/json",
});

const input = (
  password = "never-return-this",
  engine: "postgresql" | "mysql" | "sqlserver" = "postgresql",
) => ({
  name: "warehouse",
  engine,
  host: "10.35.180.238",
  port: engine === "mysql" ? 3306 : engine === "sqlserver" ? 1433 : 5432,
  database: "takaful",
  username: "salur_reader",
  password,
  ssl: { mode: "disable" },
});

function mockSuccessfulDatabase() {
  mocks.push(
    spyOn(connector, "testConnection").mockResolvedValue({
      ok: true,
      value: { latencyMs: 2, serverVersion: "17" },
    }),
    spyOn(connector, "fetchCatalog").mockResolvedValue({
      ok: true,
      value: { tables: [], columns: [], primaryKeys: [], foreignKeys: [], indexes: [] },
    }),
  );
}

beforeAll(async () => {
  (env as { connectionSecret: string }).connectionSecret = "database-integration-secret";
  (env as { authMode: typeof env.authMode }).authMode = "proxy";
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));
  ({ databaseConnector: connector } = await import("./services/db/database-connector.service"));
  ({ databaseConnectionStore: store } = await import("./repositories/database-connection.repository"));
});

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

describe("database connector HTTP surface", () => {
  for (const body of ["null", "[]"]) {
    it(`rejects a non-object JSON body: ${body}`, async () => {
      const res = await createApp().request("/api/databases/test", {
        method: "POST",
        headers: headers("db-invalid-body-user"),
        body,
      });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe("invalid_configuration");
    });
  }

  it("requires authenticated workspace ownership for connector operations", async () => {
    const res = await createApp().request("/api/databases/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(res.status).toBe(401);
  });

  it("creates a structured connection and redacts credentials from API responses", async () => {
    mockSuccessfulDatabase();
    const res = await createApp().request("/api/databases", {
      method: "POST",
      headers: headers("db-create-user"),
      body: JSON.stringify(input()),
    });
    const text = await res.text();

    expect(res.status).toBe(201);
    expect(text).not.toContain("never-return-this");
    expect(text).not.toContain("postgresql://");
    expect(JSON.parse(text).connection).toMatchObject({
      engine: "postgresql",
      host: "10.35.180.238",
      port: 5432,
      database: "takaful",
      username: "salur_reader",
      sslMode: "disable",
    });
  });

  it("creates and returns a MySQL connection without exposing credentials", async () => {
    mockSuccessfulDatabase();
    const res = await createApp().request("/api/databases", {
      method: "POST",
      headers: headers("db-create-mysql-user"),
      body: JSON.stringify(input("mysql-never-return-this", "mysql")),
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(JSON.parse(text).connection).toMatchObject({ engine: "mysql", port: 3306 });
    expect(text).not.toContain("mysql-never-return-this");
    expect(text).not.toContain("mysql://");
  });

  it("creates and returns a SQL Server connection without exposing credentials", async () => {
    mockSuccessfulDatabase();
    const res = await createApp().request("/api/databases", {
      method: "POST",
      headers: headers("db-create-sqlserver-user"),
      body: JSON.stringify(input("sqlserver-never-return-this", "sqlserver")),
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(JSON.parse(text).connection).toMatchObject({ engine: "sqlserver", port: 1433 });
    expect(text).not.toContain("sqlserver-never-return-this");
    expect(text).not.toContain("sqlserver://");
    expect(text).not.toContain("mssql://");
  });

  it("updates settings without requiring the password to be returned and resubmitted", async () => {
    mockSuccessfulDatabase();
    const user = "db-update-user";
    const created = await createApp().request("/api/databases", {
      method: "POST",
      headers: headers(user),
      body: JSON.stringify(input("preserved-password")),
    });
    const id = ((await created.json()) as any).connection.id as string;

    const updated = await createApp().request(`/api/databases/${id}`, {
      method: "PATCH",
      headers: headers(user),
      body: JSON.stringify({ ...input(), name: "warehouse_2", password: undefined }),
    });
    const text = await updated.text();
    expect(updated.status).toBe(200);
    expect(text).not.toContain("preserved-password");

    const workspace = await (await import("./repositories/workspace-registry.repository")).workspaceRegistry.resolve(user);
    expect((await store.resolveConfig(workspace.id, id))?.password).toBe("preserved-password");
  });

  it("does not reconnect or re-introspect for no-op and rename-only updates", async () => {
    const testSpy = spyOn(connector, "testConnection").mockResolvedValue({
      ok: true,
      value: { latencyMs: 2, serverVersion: "17" },
    });
    const catalogSpy = spyOn(connector, "fetchCatalog").mockResolvedValue({
      ok: true,
      value: { tables: [], columns: [], primaryKeys: [], foreignKeys: [], indexes: [] },
    });
    mocks.push(testSpy, catalogSpy);

    const user = "db-noop-user";
    const created = await createApp().request("/api/databases", {
      method: "POST",
      headers: headers(user),
      body: JSON.stringify(input("preserved-password")),
    });
    const id = ((await created.json()) as any).connection.id as string;
    expect(testSpy).toHaveBeenCalledTimes(1);
    expect(catalogSpy).toHaveBeenCalledTimes(1);

    for (const name of ["warehouse", "warehouse_renamed"]) {
      const response = await createApp().request(`/api/databases/${id}`, {
        method: "PATCH",
        headers: headers(user),
        body: JSON.stringify({ ...input(), name, password: undefined }),
      });
      expect(response.status).toBe(200);
    }
    expect(testSpy).toHaveBeenCalledTimes(1);
    expect(catalogSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects loopback before calling the database driver", async () => {
    const res = await createApp().request("/api/databases/test", {
      method: "POST",
      headers: headers("db-ssrf-user"),
      body: JSON.stringify({ ...input(), host: "127.0.0.1" }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("target_not_allowed");
    expect(JSON.stringify(body)).not.toContain("never-return-this");
  });

  it("does not let another authenticated user test an owned connection", async () => {
    mockSuccessfulDatabase();
    const created = await createApp().request("/api/databases", {
      method: "POST",
      headers: headers("db-owner"),
      body: JSON.stringify(input()),
    });
    const id = ((await created.json()) as any).connection.id as string;
    const res = await createApp().request(`/api/databases/${id}/test`, {
      method: "POST",
      headers: headers("db-other-user"),
    });
    expect(res.status).toBe(404);
  });
});
