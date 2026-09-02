import { describe, expect, it } from "bun:test";
import type { DatabaseConnectionConfig } from "./database-adapter";
import {
  boundMysqlCap,
  createMysqlAdapter,
  guardMysqlStatement,
  mysqlAdapter,
  mysqlTlsOptions,
  parseMysqlServerVersion,
  type MysqlSqlClient,
} from "./mysql.driver";
import { DATABASE_ROW_CAP } from "./query-policy";

const config: DatabaseConnectionConfig = {
  engine: "mysql",
  host: "db.internal",
  port: 3306,
  database: "inventory",
  username: "reader",
  password: "test-only-secret/@ value",
  ssl: { mode: "disable" },
};
const target = { originalHost: config.host, address: "10.20.30.40", family: 4 as const };

type FakeState = { calls: { statement: string; values?: unknown[] }[]; closed: number; cancelled: number };

function fakeClient(
  handler: (statement: string, values?: unknown[]) => unknown = () => [],
): { client: MysqlSqlClient; state: FakeState } {
  const state: FakeState = { calls: [], closed: 0, cancelled: 0 };
  const client: MysqlSqlClient = {
    unsafe<T>(statement: string, values?: unknown[]) {
      state.calls.push({ statement, values });
      const promise = Promise.resolve().then(() => handler(statement, values)) as Promise<T> & { cancel?: () => void };
      promise.cancel = () => { state.cancelled++; };
      return promise;
    },
    async close() { state.closed++; },
  };
  return { client, state };
}

const identity = (raw: string, databaseName = config.database) => [{
  serverVersion: raw,
  databaseName,
  authenticatedAs: "reader@%",
}];

function adapterWith(
  handler: (statement: string, values?: unknown[]) => unknown,
): { adapter: ReturnType<typeof createMysqlAdapter>; state: FakeState } {
  const { client, state } = fakeClient(handler);
  return { adapter: createMysqlAdapter(() => client), state };
}

describe("MySQL adapter validation", () => {
  it("declares MySQL capabilities and quotes identifiers", () => {
    expect(mysqlAdapter.engine).toBe("mysql");
    expect(mysqlAdapter.defaultPort).toBe(3306);
    expect(mysqlAdapter.capabilities).toMatchObject({
      schemas: true,
      explain: true,
      readOnlyTransactions: true,
      statementTimeout: true,
    });
    expect(mysqlAdapter.quoteIdentifier("odd`name")).toBe("`odd``name`");
  });

  for (const [field, changed] of [
    ["host", { host: "bad\nhost" }],
    ["port", { port: 0 }],
    ["database", { database: "bad\0db" }],
    ["username", { username: "bad\ruser" }],
    ["password", { password: "bad\npassword" }],
    ["ssl.mode", { ssl: { mode: "prefer" } }],
    ["ssl.serverName", { ssl: { mode: "verify-full", serverName: "bad/name" } }],
  ] as const) {
    it(`rejects malformed ${field}`, () => {
      const candidate = {
        ...config,
        ...changed,
        ssl: "ssl" in changed ? { ...config.ssl, ...changed.ssl } : config.ssl,
      } as DatabaseConnectionConfig;
      expect(mysqlAdapter.validate(candidate)?.field).toBe(field);
    });
  }

  it("maps TLS modes while retaining the original host for SNI", () => {
    expect(mysqlTlsOptions(config, target)).toBe(false);
    expect(mysqlTlsOptions({ ...config, ssl: { mode: "require" } }, target)).toEqual({
      rejectUnauthorized: false,
      serverName: "db.internal",
    });
    expect(mysqlTlsOptions({
      ...config,
      ssl: { mode: "verify-full", ca: "test CA", serverName: "db-tls.internal" },
    }, target)).toEqual({ rejectUnauthorized: true, serverName: "db-tls.internal", ca: "test CA" });
  });
});

describe("MySQL and MariaDB versions", () => {
  it("parses Oracle MySQL separately from MariaDB", () => {
    expect(parseMysqlServerVersion("8.0.46-commercial")?.product).toBe("MySQL");
    expect(parseMysqlServerVersion("8.0.46-commercial")?.version).toBe("8.0.46");
    expect(parseMysqlServerVersion("5.5.64-MariaDB")?.product).toBe("MariaDB");
    expect(parseMysqlServerVersion("5.5.5-10.5.17-MariaDB-1:10.5.17+maria")?.version).toBe("10.5.17");
  });

  it("rejects MySQL 4.x after reading the required server identity", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("4.1.24");
      return [];
    });
    const result = await adapter.testConnection(config, target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_version");
    expect(state.calls.some((call) => /CURRENT_USER/i.test(call.statement))).toBe(true);
    expect(state.calls.some((call) => /START TRANSACTION/i.test(call.statement))).toBe(false);
    expect(state.closed).toBe(1);
  });

  it("accepts MySQL 8 and enables its server-side SELECT timeout", async () => {
    const { adapter, state } = adapterWith((statement) =>
      /SELECT VERSION/i.test(statement) ? identity("8.0.46") : [],
    );
    const result = await adapter.testConnection(config, target);
    expect(result).toMatchObject({
      ok: true,
      value: { serverVersion: "8.0.46", serverProduct: "MySQL" },
    });
    expect(state.calls.map((call) => call.statement)).toEqual(expect.arrayContaining([
      "START TRANSACTION READ ONLY",
      "SET SESSION max_execution_time = 10000",
      "ROLLBACK",
    ]));
    expect(JSON.stringify(result)).not.toContain("authenticatedAs");
  });

  it("uses MariaDB timeout syntax when the server supports it", async () => {
    const { adapter, state } = adapterWith((statement) =>
      /SELECT VERSION/i.test(statement) ? identity("10.11.8-MariaDB") : [],
    );
    const result = await adapter.testConnection(config, target);
    expect(result).toMatchObject({ ok: true, value: { serverProduct: "MariaDB", serverVersion: "10.11.8" } });
    expect(state.calls.some((call) => call.statement === "SET SESSION max_statement_time = 10")).toBe(true);
  });

  it("fails closed when a legacy MariaDB cannot establish READ ONLY", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("5.5.64-MariaDB");
      if (/START TRANSACTION/i.test(statement)) throw new Error("syntax error near READ ONLY");
      return [];
    });
    const result = await adapter.testConnection(config, target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_capability");
    expect(state.closed).toBe(1);
  });
});

describe("MySQL query policy", () => {
  for (const sql of [
    "SELECT * FROM orders INTO OUTFILE '/tmp/orders'",
    "SELECT * FROM orders INTO DUMPFILE '/tmp/orders'",
    "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT GET_LOCK('x', 1)",
    "SELECT RELEASE_LOCK('x')",
    "SELECT IS_FREE_LOCK('x')",
    "SELECT IS_USED_LOCK('x')",
    "SELECT SLEEP(10)",
    "SELECT `SLEEP`(10)",
    "SELECT BENCHMARK(1000, SHA1('x'))",
    "SELECT @answer := 42",
    "SELECT @'answer' := 42",
    "SELECT id INTO @answer FROM orders",
    "SELECT 1; SELECT 2",
    "SELECT 1--not-a-comment; SELECT 2",
    "SELECT 1 /*!50000 UNION SELECT SLEEP(10) */",
  ]) {
    it(`rejects unsafe SQL: ${sql.slice(0, 36)}`, () => {
      const result = guardMysqlStatement(sql);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("query_rejected");
    });
  }

  for (const sql of [
    "SELECT 'SLEEP() INTO OUTFILE' AS text",
    "SELECT \"GET_LOCK()\" AS text",
    "SELECT `release_lock()` FROM audit",
    "SELECT 1 -- SLEEP(10)",
    "SELECT 1 # BENCHMARK(1, 1)",
    "SELECT 'it\\\'s LOAD_FILE()' AS text",
  ]) {
    it(`ignores dangerous words in inert SQL text: ${sql.slice(0, 36)}`, () => {
      expect(guardMysqlStatement(sql).ok).toBe(true);
    });
  }

  it("preserves EXPLAIN instead of wrapping it", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      return [];
    });
    await adapter.executeReadOnly(config, target, "/* plan */ EXPLAIN SELECT * FROM orders");
    expect(state.calls.some((call) => call.statement === "/* plan */ EXPLAIN SELECT * FROM orders")).toBe(true);
  });

  it("rechecks strings against the server's NO_BACKSLASH_ESCAPES mode", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/@@SESSION\.sql_mode/i.test(statement)) return [{ sqlMode: "NO_BACKSLASH_ESCAPES" }];
      return [];
    });
    const result = await adapter.executeReadOnly(
      config,
      target,
      "SELECT 'safe\\\'; SELECT SLEEP(1); SELECT '\\''",
    );
    expect(result.ok).toBe(false);
    expect(state.calls.some((call) => /AS `_capped`/i.test(call.statement))).toBe(false);
    expect(state.closed).toBe(1);
  });

  for (const value of [undefined, NaN, Infinity, -5, 0, 5.7, 1000]) {
    it(`clamps cap ${String(value)}`, () => {
      const result = boundMysqlCap(value as number);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(DATABASE_ROW_CAP);
    });
  }
});

describe("MySQL execution and catalog lifecycle", () => {
  it("wraps ordinary queries and reports row truncation", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/AS `_capped`/i.test(statement)) return [{ n: 1 }, { n: 2 }, { n: 3 }];
      return [];
    });
    const result = await adapter.executeReadOnly(config, target, "SELECT n FROM numbers", 2);
    expect(result).toMatchObject({ ok: true, rows: [{ n: 1 }, { n: 2 }], truncated: true, truncatedReason: "rows" });
    const query = state.calls.find((call) => /AS `_capped`/i.test(call.statement))?.statement;
    expect(query).toContain("LIMIT 3");
    expect(query).toContain("SELECT * FROM (\nSELECT n FROM numbers\n)");
  });

  it("safely sizes bigint rows and enforces the byte cap", async () => {
    const { adapter } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/AS `_capped`/i.test(statement)) return [{ id: 1n }, { payload: "x".repeat(60_000) }];
      return [];
    });
    const result = await adapter.executeReadOnly(config, target, "SELECT payload FROM wide_rows");
    expect(result).toMatchObject({ ok: true, rows: [{ id: 1n }], truncated: true, truncatedReason: "bytes" });
  });

  it("rolls back and closes when user SQL fails", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/AS `_capped`/i.test(statement)) throw new Error("query failed");
      return [];
    });
    const result = await adapter.executeReadOnly(config, target, "SELECT * FROM missing");
    expect(result.ok).toBe(false);
    expect(state.calls.at(-1)?.statement).toBe("ROLLBACK");
    expect(state.closed).toBe(1);
  });

  it("rolls back and closes when timeout setup fails after BEGIN", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/max_execution_time/i.test(statement)) throw new Error("timeout variable unavailable");
      return [];
    });
    const result = await adapter.executeReadOnly(config, target, "SELECT 1");
    expect(result.ok).toBe(false);
    expect(state.calls.at(-1)?.statement).toBe("ROLLBACK");
    expect(state.closed).toBe(1);
  });

  it("redacts plaintext and encoded passwords from errors", async () => {
    const encoded = encodeURIComponent(config.password);
    const { adapter } = adapterWith(() => {
      throw new Error(`failed mysql://reader:${encoded}@db.internal/inventory using ${config.password}`);
    });
    const result = await adapter.testConnection(config, target);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(config.password);
    expect(JSON.stringify(result)).not.toContain(encoded);
    expect(JSON.stringify(result)).not.toContain("db.internal/inventory");
  });

  it("returns a useful unknown-database error instead of authentication failed", async () => {
    const { adapter } = adapterWith(() => {
      const error = new Error("Unknown database 'inventory'") as Error & { code: string; errno: number };
      error.code = "ER_BAD_DB_ERROR";
      error.errno = 1049;
      throw error;
    });
    const result = await adapter.testConnection(config, target);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_configuration", field: "database" },
    });
  });

  it("restricts every catalog query and reports all five stages", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/information_schema\.tables/i.test(statement)) return [{ schemaName: "inventory", name: "items", comment: "", rowEstimate: 5n }];
      if (/information_schema\.columns/i.test(statement)) return [{ schemaName: "inventory", tableName: "items", seq: 1, name: "id", dataType: "bigint(20)", isNullable: "NO", comment: null }];
      if (/table_constraints/i.test(statement)) return [{ schemaName: "inventory", tableName: "items", columnName: "id" }];
      if (/key_column_usage/i.test(statement)) return [];
      if (/information_schema\.statistics/i.test(statement)) return [{ schemaName: "inventory", tableName: "items", indexName: "PRIMARY", nonUnique: 0, seq: 1, columnName: "id", subPart: null, collation: "A" }];
      return [];
    });
    const stages: string[] = [];
    const result = await adapter.fetchCatalog(config, target, (stage) => stages.push(stage.step));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tables[0]?.rowEstimate).toBe(5);
      expect(result.value.indexes[0]?.definition).toBe("UNIQUE INDEX `PRIMARY` (`id`)");
    }
    expect(stages).toEqual(["tables", "columns", "primaryKeys", "foreignKeys", "indexes"]);
    const catalogCalls = state.calls.filter((call) => /information_schema/i.test(call.statement));
    expect(catalogCalls).toHaveLength(5);
    expect(catalogCalls.every((call) => /TABLE_SCHEMA = \?/i.test(call.statement) && call.values?.[0] === config.database)).toBe(true);
    expect(catalogCalls.every((call) => /information_schema.*performance_schema.*sys/is.test(call.statement))).toBe(true);
    expect(state.calls.at(-1)?.statement).toBe("ROLLBACK");
    expect(state.closed).toBe(1);
  });
});
