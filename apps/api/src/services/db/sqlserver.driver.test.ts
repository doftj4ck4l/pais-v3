import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { DatabaseConnectionConfig } from "./database-adapter";
import {
  SQLSERVER_IP_SNI_PLACEHOLDER,
  blankSqlServerLiteralsAndComments,
  boundSqlServerCap,
  createSqlServerAdapter,
  createSqlServerConnector,
  guardSqlServerStatement,
  isReadOnlySqlServerPrincipal,
  sqlserverConnectionOptions,
  sqlserverTlsSettings,
  type SqlServerClient,
  type SqlServerQueryResult,
  type SqlServerRecordset,
} from "./sqlserver.driver";

const config: DatabaseConnectionConfig = {
  engine: "sqlserver",
  host: "sql.example.com",
  port: 1433,
  database: "Inventory",
  username: "readonly_user",
  password: "p@ss / word",
  ssl: { mode: "require" },
};

const target = { originalHost: "sql.example.com", address: "10.20.30.40", family: 4 as const };
const identity = {
  serverVersion: "15.0.2080.9",
  productLevel: "RTM",
  edition: "Standard Edition (64-bit)",
  databaseName: "inventory",
  loginName: "readonly_user",
  databaseUser: "readonly_user",
};
const permissions = {
  hasSelect: 1,
  isDataWriter: 0,
  isDbOwner: 0,
  isSysadmin: 0,
  dangerousDatabasePermissions: 0,
  dangerousServerPermissions: 0,
  dangerousSchemaPermissions: 0,
  dangerousObjectPermissions: 0,
};

const result = (rows: Record<string, unknown>[] = []): SqlServerQueryResult => ({
  recordset: rows as SqlServerRecordset,
  recordsets: [rows as SqlServerRecordset],
});

function fakeClient(responses: Array<SqlServerQueryResult | Error | ((sql: string) => SqlServerQueryResult)>) {
  const calls: string[] = [];
  const state = { connected: 0, began: 0, rolledBack: 0, closed: 0, requests: 0 };
  let index = 0;
  const request = () => ({
    timeout: 0,
    async query(sql: string) {
      calls.push(sql);
      const response = responses[index++];
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response(sql);
      return response ?? result();
    },
  });
  const client: SqlServerClient = {
    async connect() { state.connected++; },
    async close() { state.closed++; },
    request() { state.requests++; return request(); },
    transaction() {
      return {
        async begin() { state.began++; },
        async rollback() { state.rolledBack++; },
        request() { state.requests++; return request(); },
      };
    },
  };
  return { client, calls, state };
}

describe("SQL Server adapter", () => {
  it("declares its metadata and escapes bracket identifiers", () => {
    const adapter = createSqlServerAdapter(async () => fakeClient([]).client);
    expect(adapter.engine).toBe("sqlserver");
    expect(adapter.defaultPort).toBe(1433);
    expect(adapter.capabilities).toEqual({
      schemas: true,
      explain: false,
      sslModes: ["disable", "require", "verify-full"],
      readOnlyTransactions: false,
      statementTimeout: true,
    });
    expect(adapter.quoteIdentifier("odd]name")).toBe("[odd]]name]");
  });

  it("validates fields, TLS settings, and IP verify-full identity", () => {
    const adapter = createSqlServerAdapter(async () => fakeClient([]).client);
    expect(adapter.validate(config)).toBeNull();
    for (const [change, field] of [
      [{ host: "" }, "host"],
      [{ port: 0 }, "port"],
      [{ database: "" }, "database"],
      [{ username: "" }, "username"],
      [{ password: "" }, "password"],
    ] as const) {
      expect(adapter.validate({ ...config, ...change })?.field).toBe(field);
    }
    expect(adapter.validate({ ...config, password: "bad\npassword" })?.field).toBe("password");
    expect(adapter.validate({ ...config, ssl: { mode: "verify-full", ca: "x\0y" } })?.field).toBe("ssl.ca");
    expect(adapter.validate({ ...config, ssl: { mode: "verify-full", serverName: "bad/name" } })?.field).toBe("ssl.serverName");
    expect(adapter.validate({ ...config, host: "10.2.3.4", ssl: { mode: "verify-full" } })?.field).toBe("ssl.serverName");
    expect(adapter.validate({ ...config, host: "10.2.3.4", ssl: { mode: "verify-full", serverName: "db.example.com" } })).toBeNull();
    expect(adapter.validate({ ...config, ssl: { mode: "bogus" as any } })?.field).toBe("ssl.mode");
  });

  it("maps disable, require, and verify-full TLS options", () => {
    expect(sqlserverTlsSettings({ ...config, ssl: { mode: "disable" } }, target)).toEqual({
      encrypt: false,
      trustServerCertificate: true,
    });
    expect(sqlserverTlsSettings(config, target)).toMatchObject({
      encrypt: true,
      trustServerCertificate: true,
      serverName: "sql.example.com",
    });
    expect(sqlserverTlsSettings(
      { ...config, ssl: { mode: "verify-full", ca: "PEM", serverName: "tls.example.com" } },
      target,
    )).toEqual({
      encrypt: true,
      trustServerCertificate: false,
      serverName: "tls.example.com",
      cryptoCredentialsDetails: { ca: "PEM" },
    });
  });

  it("never uses a raw IP as encrypted TLS serverName", () => {
    const ipTarget = { ...target, originalHost: "10.20.30.40" };
    expect(sqlserverTlsSettings({ ...config, host: ipTarget.originalHost }, ipTarget).serverName)
      .toBe(SQLSERVER_IP_SNI_PLACEHOLDER);
    expect(sqlserverTlsSettings(
      { ...config, host: ipTarget.originalHost, ssl: { mode: "require", serverName: "tls.example.com" } },
      ipTarget,
    ).serverName).toBe("tls.example.com");
  });

  it("pins the custom connector to target.address", async () => {
    const socket = new EventEmitter() as Socket;
    const dialed: Array<{ host: string; port: number }> = [];
    const connector = createSqlServerConnector(target, 1433, ((options: { host: string; port: number }) => {
      dialed.push(options);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }) as any);
    expect(await connector()).toBe(socket);
    expect(dialed).toEqual([{ host: "10.20.30.40", port: 1433 }]);

    const options = sqlserverConnectionOptions(config, target);
    expect(options).toMatchObject({
      server: "sql.example.com",
      port: 1433,
      connectionTimeout: 10_000,
      requestTimeout: 10_000,
      pool: { max: 1 },
      options: { appName: "Pixelspace", enableArithAbort: true },
    });
  });

  it("maps server identity and accepts a least-privilege login", async () => {
    const fake = fakeClient([result([identity]), result([permissions])]);
    const adapter = createSqlServerAdapter(async () => fake.client);
    expect(await adapter.testConnection(config, target)).toEqual({
      ok: true,
      value: { serverProduct: "SQL Server", serverVersion: "15.0.2080.9" },
    });
    expect(fake.state).toMatchObject({ connected: 1, closed: 1 });
    expect(fake.calls[0]).toContain("SERVERPROPERTY('ProductVersion')");
    expect(fake.calls[0]).toContain("DB_NAME()");
  });

  it("accepts only effective SELECT-only permission results", () => {
    expect(isReadOnlySqlServerPrincipal(permissions)).toBe(true);
    for (const override of [
      { hasSelect: 0 },
      { isDataWriter: 1 },
      { isDbOwner: 1 },
      { isDbDdlAdmin: 1 },
      { isSysadmin: 1 },
      { isServerAdmin: 1 },
      { dangerousDatabasePermissions: 1 },
      { dangerousServerPermissions: 1 },
      { dangerousSchemaPermissions: 1 },
      { dangerousObjectPermissions: 1 },
    ]) expect(isReadOnlySqlServerPrincipal({ ...permissions, ...override })).toBe(false);
  });

  it("rejects writer and administrator principals with a safe message", async () => {
    for (const override of [{ isDataWriter: 1 }, { isDbOwner: 1 }, { isSysadmin: 1 }]) {
      const fake = fakeClient([result([identity]), result([{ ...permissions, ...override }])]);
      const outcome = await createSqlServerAdapter(async () => fake.client).testConnection(config, target);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "unsupported_capability", message: "SQL Server connections require a read-only database login" },
      });
      expect(fake.state.closed).toBe(1);
    }
  });

  it("maps and deterministically sorts all catalog stages", async () => {
    const fake = fakeClient([
      result([identity]),
      result([permissions]),
      result([
        { schemaName: "z", name: "view", comment: null, rowEstimate: 0 },
        { schemaName: "dbo", name: "items", comment: "Items", rowEstimate: 12n },
      ]),
      result([
        { schemaName: "dbo", tableName: "items", seq: 2, name: "label", dataType: "nvarchar(40)", nullable: true, comment: "Label" },
        { schemaName: "dbo", tableName: "items", seq: 1, name: "id", dataType: "int", nullable: false, comment: null },
      ]),
      result([{ schemaName: "dbo", tableName: "items", columnName: "id" }]),
      result([{ schemaName: "dbo", tableName: "items", columnName: "parent_id", refSchema: "dbo", refTable: "parents", refColumn: "id" }]),
      result([
        { schemaName: "dbo", tableName: "items", indexName: "ix_items", isUnique: 1, typeDescription: "NONCLUSTERED", filterDefinition: "[active]=(1)", keyOrdinal: 0, indexColumnId: 3, isIncluded: 1, isDescending: 0, columnName: "label" },
        { schemaName: "dbo", tableName: "items", indexName: "ix_items", isUnique: 1, typeDescription: "NONCLUSTERED", filterDefinition: "[active]=(1)", keyOrdinal: 1, indexColumnId: 1, isIncluded: 0, isDescending: 1, columnName: "id" },
      ]),
    ]);
    const steps: unknown[] = [];
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .fetchCatalog(config, target, (step) => steps.push(step));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.tables.map((table) => `${table.schemaName}.${table.name}`)).toEqual(["dbo.items", "z.view"]);
    expect(outcome.value.tables[0]).toMatchObject({ comment: "Items", rowEstimate: 12 });
    expect(outcome.value.columns.map((column) => column.name)).toEqual(["id", "label"]);
    expect(outcome.value.columns[1]).toMatchObject({ dataType: "nvarchar(40)", nullable: true, comment: "Label" });
    expect(outcome.value.primaryKeys).toHaveLength(1);
    expect(outcome.value.foreignKeys[0]).toMatchObject({ columnName: "parent_id", refTable: "parents" });
    expect(outcome.value.indexes[0]?.definition).toBe("UNIQUE NONCLUSTERED INDEX [ix_items] ([id] DESC) INCLUDE ([label]) WHERE [active]=(1)");
    expect(steps).toEqual([
      { step: "tables", count: 2 },
      { step: "columns", count: 2 },
      { step: "primaryKeys", count: 1 },
      { step: "foreignKeys", count: 1 },
      { step: "indexes", count: 1 },
    ]);
    expect(fake.state.closed).toBe(1);
  });
});

describe("SQL Server statement guard", () => {
  for (const sql of [
    "SELECT 1",
    "WITH values_cte AS (SELECT 1 AS n) SELECT n FROM values_cte",
    "SELECT [update]]name] FROM [orders]",
    "SELECT \"delete\" FROM \"audit\"",
    "SELECT 'update; GO' AS value /* DROP TABLE x /* nested */ */",
    "SELECT 1; -- trailing comment",
  ]) {
    it(`accepts ${sql}`, () => expect(guardSqlServerStatement(sql).ok).toBe(true));
  }

  for (const [sql, reason] of [
    ["SELECT * INTO copied FROM source", "SELECT INTO"],
    ["WITH changed AS (SELECT 1 AS n) UPDATE target SET n = 1", "UPDATE"],
    ["SELECT 1\nGO\nSELECT 2", "GO"],
    ["SELECT 1\nGO 2", "GO"],
    ["SELECT 1; SELECT 2", "one SQL statement"],
    ["SELECT * FROM OPENROWSET('x', 'y', 'z')", "OPENROWSET"],
    ["SELECT * FROM OPENQUERY(linked, 'SELECT 1')", "OPENQUERY"],
    ["SELECT * FROM OPENDATASOURCE('provider', 'source').db.dbo.items", "OPENDATASOURCE"],
    ["SELECT * FROM OPENXML(@document, '/root')", "OPENXML"],
    ["EXPLAIN SELECT 1", "SELECT or WITH"],
  ]) {
    it(`rejects ${sql}`, () => {
      const guarded = guardSqlServerStatement(sql);
      expect(guarded.ok).toBe(false);
      if (!guarded.ok) expect(guarded.error.message).toContain(reason);
    });
  }

  it("recognizes malformed nested comments and escaped brackets", () => {
    expect(blankSqlServerLiteralsAndComments("SELECT [a]]b] /* outer /* inner */ done */").ok).toBe(true);
    expect(blankSqlServerLiteralsAndComments("SELECT 1 /* open").ok).toBe(false);
  });
});

describe("SQL Server read-only execution", () => {
  it("uses SET ROWCOUNT limit+1, trims rows, and always rolls back and closes", async () => {
    const fake = fakeClient([
      result([identity]), result([permissions]), result(),
      result([{ n: 1 }, { n: 2 }, { n: 3 }]),
    ]);
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT n FROM numbers", 2);
    expect(outcome).toEqual({
      ok: true,
      columns: ["n"],
      rows: [{ n: 1 }, { n: 2 }],
      truncated: true,
      truncatedReason: "rows",
    });
    expect(fake.calls[2]).toContain("SET ROWCOUNT 3");
    expect(fake.calls[3]).toBe("SELECT n FROM numbers");
    expect(fake.state).toMatchObject({ began: 1, rolledBack: 1, closed: 1 });
  });

  it("enforces the shared row cap", () => {
    expect(boundSqlServerCap(Number.POSITIVE_INFINITY)).toBe(100);
    expect(boundSqlServerCap(10_000)).toBe(100);
    expect(boundSqlServerCap(2.9)).toBe(2);
    expect(boundSqlServerCap(0)).toBe(1);
  });

  it("applies the byte cap with BigInt-safe sizing", async () => {
    const fake = fakeClient([
      result([identity]), result([permissions]), result(),
      result([{ id: 1n, value: "x".repeat(60_000) }]),
    ]);
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT value FROM wide_rows", 10);
    expect(outcome).toMatchObject({ ok: true, rows: [], truncated: true, truncatedReason: "bytes" });
    expect(fake.state).toMatchObject({ rolledBack: 1, closed: 1 });
  });

  it("returns metadata for zero rows and ignores later recordsets", async () => {
    const rows = [] as unknown as SqlServerRecordset;
    Object.defineProperty(rows, "columns", { value: { item_id: { type: "Int" } } });
    const fake = fakeClient([
      result([identity]), result([permissions]), result(),
      { recordset: rows, recordsets: [rows, [{ secret: "ignored" }] as SqlServerRecordset] },
    ]);
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT item_id FROM items WHERE 1 = 0");
    expect(outcome).toMatchObject({ ok: true, columns: ["item_id"], rows: [] });
  });

  for (const [name, error, code] of [
    ["timeout", Object.assign(new Error("Request timed out"), { code: "ETIMEOUT" }), "timeout"],
    ["authentication", Object.assign(new Error("Login failed"), { code: "ELOGIN", number: 18456 }), "authentication_failed"],
    ["invalid database", Object.assign(new Error("Cannot open database requested by the login. Login failed"), { code: "ELOGIN", number: 4060 }), "invalid_configuration"],
  ] as const) {
    it(`classifies ${name} and cleans up`, async () => {
      const fake = fakeClient([result([identity]), result([permissions]), result(), error]);
      const outcome = await createSqlServerAdapter(async () => fake.client)
        .executeReadOnly(config, target, "SELECT 1");
      expect(outcome).toMatchObject({ ok: false, error: { code } });
      expect(fake.state).toMatchObject({ rolledBack: 1, closed: 1 });
    });
  }

  it("closes the pool when connection setup fails", async () => {
    const fake = fakeClient([]);
    fake.client.connect = async () => { throw Object.assign(new Error("socket failed"), { code: "ESOCKET" }); };
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT 1");
    expect(outcome).toMatchObject({ ok: false, error: { code: "connection_failed" } });
    expect(fake.state).toMatchObject({ rolledBack: 0, closed: 1 });
  });

  it("attempts rollback and closes when transaction begin fails", async () => {
    const fake = fakeClient([]);
    fake.client.transaction = () => ({
      async begin() { fake.state.began++; throw new Error("begin failed"); },
      async rollback() { fake.state.rolledBack++; },
      request: () => { throw new Error("not reached"); },
    });
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT 1");
    expect(outcome).toMatchObject({ ok: false, error: { code: "query_failed" } });
    expect(fake.state).toMatchObject({ began: 1, rolledBack: 1, closed: 1 });
  });

  it("rolls back and closes when permission preflight or ROWCOUNT setup fails", async () => {
    for (const responses of [
      [result([identity]), result([{ ...permissions, isDataWriter: 1 }])],
      [result([identity]), result([permissions]), new Error("ROWCOUNT failed")],
    ]) {
      const fake = fakeClient(responses);
      const outcome = await createSqlServerAdapter(async () => fake.client)
        .executeReadOnly(config, target, "SELECT 1");
      expect(outcome.ok).toBe(false);
      expect(fake.state).toMatchObject({ rolledBack: 1, closed: 1 });
    }
  });

  it("rejects before connecting", async () => {
    const fake = fakeClient([]);
    const outcome = await createSqlServerAdapter(async () => fake.client)
      .executeReadOnly(config, target, "UPDATE items SET value = 1");
    expect(outcome).toMatchObject({ ok: false, error: { code: "query_rejected" } });
    expect(fake.state.connected).toBe(0);
  });

  it("never exposes plaintext, encoded passwords, or SQL Server URLs", async () => {
    const encoded = encodeURIComponent(config.password);
    const fake = fakeClient([]);
    fake.client.connect = async () => {
      throw new Error(`mssql://readonly_user:${encoded}@sql.example.com/Inventory sqlserver://readonly_user:${config.password}@host/db`);
    };
    const outcome = await createSqlServerAdapter(async () => fake.client).testConnection(config, target);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).not.toContain(config.password);
    expect(outcome.error.message).not.toContain(encoded);
    expect(outcome.error.message).not.toContain("mssql://");
    expect(outcome.error.message).not.toContain("sqlserver://");
    expect(fake.state.closed).toBe(1);
  });
});
