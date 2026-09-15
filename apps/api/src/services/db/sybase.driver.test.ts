import { describe, expect, it } from "bun:test";
import type { DatabaseConnectionConfig } from "./database-adapter";
import {
  SYBASE_DEFAULT_CLIENT_CHARSET,
  SYBASE_DEFAULT_TDS_VERSION,
  blankSybaseLiteralsAndComments,
  boundSybaseCap,
  createSybaseAdapter,
  escapeOdbcValue,
  guardSybaseStatement,
  isReadOnlySybasePrincipal,
  parseSybaseServerVersion,
  sybaseConnectionString,
  type SybaseClient,
  type SybaseResult,
} from "./sybase.driver";

const config: DatabaseConnectionConfig = {
  engine: "sybase",
  host: "ase.example.com",
  port: 4001,
  database: "cukai",
  username: "airo",
  password: "p;ass}=word",
  ssl: { mode: "disable" },
};

const target = { originalHost: "ase.example.com", address: "10.2.244.181", family: 4 as const };
const identity = {
  databaseName: "cukai",
  versionText: "Adaptive Server Enterprise/15.7/EBF 99999 SMP SP110/Linux",
  databaseUser: "airo",
  databaseUserId: 42,
  hasSaRole: 0,
  hasSsoRole: 0,
  hasOperRole: 0,
};
const permissions = {
  selectGrants: 143,
  dangerousUserGrants: 0,
  dangerousGroupGrants: 0,
  ownedObjects: 0,
  assignedRoles: 0,
};

function result(rows: Record<string, unknown>[] = [], columns?: string[]): SybaseResult {
  const value = rows as SybaseResult;
  if (columns) value.columns = columns.map((name) => ({ name }));
  return value;
}

function fakeClient(
  responses: Array<SybaseResult | Error>,
  cursorResponse: SybaseResult | Error = result(),
) {
  const calls: string[] = [];
  const state = { closed: 0, cursorOpened: 0, cursorClosed: 0, fetchSize: 0 };
  let index = 0;
  const client: SybaseClient = {
    async query(statement) {
      calls.push(statement);
      const response = responses[index++];
      if (response instanceof Error) throw response;
      return response ?? result();
    },
    async openCursor(statement, fetchSize) {
      calls.push(statement);
      state.cursorOpened++;
      state.fetchSize = fetchSize;
      if (cursorResponse instanceof Error) throw cursorResponse;
      return {
        async fetch() { return cursorResponse; },
        async close() { state.cursorClosed++; },
      };
    },
    async close() { state.closed++; },
  };
  return { client, calls, state };
}

describe("SAP ASE adapter", () => {
  it("declares safe initial capabilities and defaults", () => {
    const adapter = createSybaseAdapter(async () => fakeClient([]).client);
    expect(adapter.engine).toBe("sybase");
    expect(adapter.defaultPort).toBe(5000);
    expect(adapter.capabilities).toEqual({
      schemas: true,
      explain: false,
      sslModes: ["disable"],
      readOnlyTransactions: false,
      statementTimeout: true,
    });
    expect(adapter.quoteIdentifier("odd]name")).toBe("[odd]]name]");
    expect(SYBASE_DEFAULT_TDS_VERSION).toBe("5.0");
    expect(SYBASE_DEFAULT_CLIENT_CHARSET).toBe("ISO-8859-1");
  });

  it("validates fields and explicitly rejects unimplemented TLS", () => {
    const adapter = createSybaseAdapter(async () => fakeClient([]).client);
    expect(adapter.validate(config)).toBeNull();
    for (const [change, field] of [
      [{ host: "" }, "host"],
      [{ port: 0 }, "port"],
      [{ database: "" }, "database"],
      [{ username: "" }, "username"],
      [{ password: "" }, "password"],
    ] as const) expect(adapter.validate({ ...config, ...change })?.field).toBe(field);
    expect(adapter.validate({ ...config, ssl: { mode: "require" } })).toMatchObject({
      code: "unsupported_capability",
      field: "ssl.mode",
    });
    expect(adapter.validate({ ...config, sybase: { tdsVersion: "7.4" } })?.field).toBe("sybase.tdsVersion");
    expect(adapter.validate({ ...config, sybase: { clientCharset: "bad;charset" } })?.field).toBe("sybase.clientCharset");
  });

  it("brace-quotes every ODBC value and uses only target.address as the destination", () => {
    expect(escapeOdbcValue("a;b}=c")).toBe("{a;b}}=c}");
    expect(escapeOdbcValue("a};b{=c")).toBe("{a}};b{=c}");
    const connectionString = sybaseConnectionString(config, target);
    expect(connectionString).toContain("Driver={FreeTDS}");
    expect(connectionString).toContain("Server={10.2.244.181}");
    expect(connectionString).toContain("Port={4001}");
    expect(connectionString).toContain("PWD={p;ass}}=word}");
    expect(connectionString).toContain("TDS_Version={5.0}");
    expect(connectionString).toContain("ClientCharset={ISO-8859-1}");
    expect(connectionString).toContain("Encryption={off}");
    expect(connectionString).not.toContain(target.originalHost);
  });

  it("detects ASE and parses its service pack while rejecting OpenServer endpoints", () => {
    expect(parseSybaseServerVersion(identity.versionText)).toEqual({ version: "15.7 SP110", raw: identity.versionText });
    expect(parseSybaseServerVersion("Backup Server/15.7 SP110")).toBeNull();
    expect(parseSybaseServerVersion("Open Server 15.7 Adaptive Server Enterprise")).toBeNull();
  });

  it("authenticates, verifies the selected database and product, and closes", async () => {
    const fake = fakeClient([result([identity]), result([permissions]), result()]);
    const outcome = await createSybaseAdapter(async () => fake.client).testConnection(config, target);
    expect(outcome).toEqual({ ok: true, value: { serverProduct: "SAP ASE", serverVersion: "15.7 SP110" } });
    expect(fake.calls[0]).toContain("db_name()");
    expect(fake.calls[0]).toContain("@@version");
    expect(fake.calls[2]).toBe("sp_displayroles");
    expect(fake.state.closed).toBe(1);
  });

  it("conservatively accepts only SELECT-only non-owner principals", () => {
    expect(isReadOnlySybasePrincipal(identity, permissions)).toBe(true);
    for (const [identityChange, permissionChange] of [
      [{ databaseUserId: 1 }, {}],
      [{ hasSaRole: 1 }, {}],
      [{ hasSsoRole: 1 }, {}],
      [{ hasOperRole: 1 }, {}],
      [{}, { selectGrants: 0 }],
      [{}, { dangerousUserGrants: 1 }],
      [{}, { dangerousGroupGrants: 1 }],
      [{}, { ownedObjects: 1 }],
      [{}, { assignedRoles: 1 }],
    ]) expect(isReadOnlySybasePrincipal({ ...identity, ...identityChange }, { ...permissions, ...permissionChange })).toBe(false);
  });

  it("rejects a wrong database, non-ASE product, and writable login safely", async () => {
    for (const responses of [
      [result([{ ...identity, databaseName: "master" }])],
      [result([{ ...identity, versionText: "OpenServer/15.7" }])],
      [result([identity]), result([{ ...permissions, dangerousUserGrants: 1 }]), result()],
      [result([identity]), result([permissions]), result([{ roleName: "inactive_write_role" }])],
      [result([identity]), result([permissions]), new Error("role inspection denied")],
    ]) {
      const fake = fakeClient(responses);
      const outcome = await createSybaseAdapter(async () => fake.client).testConnection(config, target);
      expect(outcome.ok).toBe(false);
      expect(fake.state.closed).toBe(1);
    }
  });

  it("maps and reports all five ASE catalog stages", async () => {
    const fake = fakeClient([
      result([identity]), result([permissions]), result(),
      result([
        { schemaName: "z", name: "view_a", comment: null, rowEstimate: 0 },
        { schemaName: "dbo", name: "items", comment: null, rowEstimate: "12" },
      ]),
      result([
        { schemaName: "dbo", tableName: "items", seq: 2, name: "parent_id", dataType: "int", nullable: 1, comment: null },
        { schemaName: "dbo", tableName: "items", seq: 1, name: "id", dataType: "numeric(10,0)", nullable: 0, comment: null },
        { schemaName: "dbo", tableName: "parents", seq: 1, name: "id", dataType: "numeric(10,0)", nullable: 0, comment: null },
      ]),
      result([{ schemaName: "dbo", tableName: "items", indexName: "pk_items", key1: "id", order1: "ASC" }]),
      result([{
        schemaName: "dbo", tableName: "items", refSchema: "dbo", refTable: "parents",
        constraintId: 8, keyCount: 1, fokey1: 2, refkey1: 1,
      }]),
      result([{ schemaName: "dbo", tableName: "items", indexName: "ix_parent", indexStatus: 2, key1: "parent_id", order1: "DESC" }]),
    ]);
    const steps: unknown[] = [];
    const outcome = await createSybaseAdapter(async () => fake.client)
      .fetchCatalog(config, target, (step) => steps.push(step));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.tables.map((table) => `${table.schemaName}.${table.name}`)).toEqual(["dbo.items", "z.view_a"]);
    expect(outcome.value.columns.map((column) => column.name)).toEqual(["id", "parent_id", "id"]);
    expect(outcome.value.primaryKeys[0]).toMatchObject({ tableName: "items", columnName: "id" });
    expect(outcome.value.foreignKeys[0]).toMatchObject({ columnName: "parent_id", refTable: "parents", refColumn: "id" });
    expect(outcome.value.indexes[0]?.definition).toBe("UNIQUE INDEX [ix_parent] ([parent_id] DESC)");
    expect(steps).toEqual([
      { step: "tables", count: 2 },
      { step: "columns", count: 3 },
      { step: "primaryKeys", count: 1 },
      { step: "foreignKeys", count: 1 },
      { step: "indexes", count: 1 },
    ]);
    expect(fake.state.closed).toBe(1);
  });

  it("maps ODBC failures without leaking raw driver details or credentials", async () => {
    const encoded = encodeURIComponent(config.password);
    const fake = fakeClient([
      Object.assign(new Error(`Driver={FreeTDS};PWD={${config.password}} sybase://airo:${encoded}@host/cukai`), {
        odbcErrors: [{ state: "28000", message: `Password ${config.password}` }],
      }),
    ]);
    const outcome = await createSybaseAdapter(async () => fake.client).testConnection(config, target);
    expect(outcome).toMatchObject({ ok: false, error: { code: "authentication_failed", message: "Database authentication failed" } });
    expect(JSON.stringify(outcome)).not.toContain(config.password);
    expect(JSON.stringify(outcome)).not.toContain(encoded);
    expect(JSON.stringify(outcome)).not.toContain("Driver=");
    expect(JSON.stringify(outcome)).not.toContain("sybase://");
    expect(fake.state.closed).toBe(1);
  });

  for (const [name, state, message, code] of [
    ["timeout", "HYT00", "query timeout expired", "timeout"],
    ["connection", "08S01", "communication link failure", "connection_failed"],
    ["invalid database", "42000", "Database cukai is not accessible error 916", "invalid_configuration"],
  ] as const) {
    it(`classifies ${name} failures without driver text`, async () => {
      const fake = fakeClient([Object.assign(new Error(message), { odbcErrors: [{ state, message }] })]);
      const outcome = await createSybaseAdapter(async () => fake.client).testConnection(config, target);
      expect(outcome).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(outcome)).not.toContain(message);
      expect(fake.state.closed).toBe(1);
    });
  }
});

describe("SAP ASE statement guard", () => {
  for (const sql of [
    "SELECT 1",
    "WITH values_cte AS (SELECT 1 AS n) SELECT n FROM values_cte",
    "SELECT [update]]name] FROM [orders]",
    "SELECT \"delete\" FROM \"audit\"",
    "SELECT 'update; GO' AS value /* DROP TABLE x /* nested */ */",
    "SELECT 1; -- trailing comment",
  ]) it(`accepts ${sql}`, () => expect(guardSybaseStatement(sql).ok).toBe(true));

  for (const [sql, reason] of [
    ["SELECT * INTO copied FROM source", "SELECT INTO"],
    ["WITH changed AS (SELECT 1 AS n) UPDATE target SET n = 1", "UPDATE"],
    ["SELECT 1 FOR UPDATE", "FOR UPDATE"],
    ["SELECT 1\nGO\nSELECT 2", "GO"],
    ["SELECT 1; SELECT 2", "one SQL statement"],
    ["SELECT 1 SELECT 2", "one SQL statement"],
    ["CREATE TABLE x (id int)", "SELECT or WITH"],
    ["DBCC checkalloc", "SELECT or WITH"],
    ["DUMP DATABASE cukai TO disk", "SELECT or WITH"],
    ["LOAD DATABASE cukai FROM disk", "SELECT or WITH"],
    ["SET ROWCOUNT 1", "SELECT or WITH"],
    ["USE master", "SELECT or WITH"],
    ["EXEC sp_help", "SELECT or WITH"],
    ["GRANT SELECT ON x TO public", "SELECT or WITH"],
    ["BEGIN TRANSACTION SELECT 1 COMMIT", "SELECT or WITH"],
  ]) {
    it(`rejects ${sql}`, () => {
      const guarded = guardSybaseStatement(sql);
      expect(guarded.ok).toBe(false);
      if (!guarded.ok) expect(guarded.error.message).toContain(reason);
    });
  }

  it("recognizes malformed comments and escaped bracket identifiers", () => {
    expect(blankSybaseLiteralsAndComments("SELECT [a]]b] /* outer /* inner */ done */").ok).toBe(true);
    expect(blankSybaseLiteralsAndComments("SELECT 1 /* open").ok).toBe(false);
  });
});

describe("SAP ASE read-only execution", () => {
  it("fetches only cap+1 rows through a cursor, trims, and closes both resources", async () => {
    const fake = fakeClient(
      [result([identity]), result([permissions]), result()],
      result([{ n: 1 }, { n: 2 }, { n: 3 }], ["n"]),
    );
    const outcome = await createSybaseAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT n FROM numbers", 2);
    expect(outcome).toEqual({
      ok: true,
      columns: ["n"],
      rows: [{ n: 1 }, { n: 2 }],
      truncated: true,
      truncatedReason: "rows",
    });
    expect(fake.state).toEqual({ closed: 1, cursorOpened: 1, cursorClosed: 1, fetchSize: 3 });
  });

  it("enforces shared row and byte caps without changing returned user data", async () => {
    expect(boundSybaseCap(Number.POSITIVE_INFINITY)).toBe(100);
    expect(boundSybaseCap(10_000)).toBe(100);
    const wide = { id: 1n, payload: "x".repeat(60_000) };
    const fake = fakeClient([result([identity]), result([permissions]), result()], result([wide]));
    const outcome = await createSybaseAdapter(async () => fake.client)
      .executeReadOnly(config, target, "SELECT payload FROM wide_rows", 10);
    expect(outcome).toMatchObject({ ok: true, rows: [], truncated: true, truncatedReason: "bytes" });
    expect(wide.id).toBe(1n);
    expect(fake.state).toMatchObject({ cursorClosed: 1, closed: 1 });
  });

  it("closes after query failures and rejects unsafe SQL before connecting", async () => {
    const failed = fakeClient([result([identity]), result([permissions]), result()], new Error("syntax near secret"));
    expect(await createSybaseAdapter(async () => failed.client)
      .executeReadOnly(config, target, "SELECT * FROM missing")).toMatchObject({ ok: false, error: { code: "query_failed" } });
    expect(failed.state.closed).toBe(1);

    let connected = false;
    const adapter = createSybaseAdapter(async () => { connected = true; return fakeClient([]).client; });
    expect(await adapter.executeReadOnly(config, target, "UPDATE x SET y = 1")).toMatchObject({
      ok: false,
      error: { code: "query_rejected" },
    });
    expect(connected).toBe(false);
  });
});
