import { describe, expect, it } from "bun:test";
import type { DatabaseConnectionConfig } from "./database-adapter";
import {
  boundMysqlCap,
  createMysqlAdapter,
  guardMysqlStatement,
  mysqlConnectionOptions,
  mysqlAdapter,
  mysqlTlsOptions,
  parseMysqlServerVersion,
  queryMysqlWithTimeout,
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

type FakeState = { calls: { statement: string; values?: unknown[] }[]; closed: number; destroyed: number };

function fakeClient(
  handler: (statement: string, values?: unknown[]) => unknown = () => [],
  databaseName = config.database,
): { client: MysqlSqlClient; state: FakeState } {
  const state: FakeState = { calls: [], closed: 0, destroyed: 0 };
  const client: MysqlSqlClient = {
    async query<T>(statement: string, values?: unknown[]) {
      state.calls.push({ statement, values });
      if (/^SHOW DATABASES$/i.test(statement.trim())) {
        return [[{ Database: databaseName }] as T, []];
      }
      return [await handler(statement, values) as T, []];
    },
    async end() { state.closed++; },
    destroy() { state.destroyed++; },
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
    ["ssl.serverName", { host: "10.20.30.40", ssl: { mode: "verify-full" } }],
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
    expect(mysqlTlsOptions(config)).toBeUndefined();
    expect(mysqlTlsOptions({ ...config, ssl: { mode: "require" } })).toEqual({
      rejectUnauthorized: false,
      verifyIdentity: false,
    });
    expect(mysqlTlsOptions({
      ...config,
      ssl: { mode: "verify-full", ca: "test CA", serverName: "db-tls.internal" },
    })).toEqual({ rejectUnauthorized: true, verifyIdentity: true, ca: "test CA" });

    const options = mysqlConnectionOptions({
      ...config,
      ssl: { mode: "verify-full", serverName: "db-tls.internal" },
    }, target);
    expect(options).toMatchObject({
      host: "db-tls.internal",
      port: 3306,
      user: "reader",
      connectTimeout: 10_000,
      multipleStatements: false,
      flags: ["-LOCAL_FILES"],
    });
    expect(options.database).toBeUndefined();
    expect(options.infileStreamFactory).toBeUndefined();
    expect(options.authPlugins).toBeUndefined();
    expect(options.insecureAuth).toBeUndefined();
    expect(options.enableCleartextPlugin).toBeUndefined();
  });
});

describe("MySQL and MariaDB versions", () => {
  it("parses Oracle MySQL separately from MariaDB", () => {
    expect(parseMysqlServerVersion("8.0.46-commercial")?.product).toBe("MySQL");
    expect(parseMysqlServerVersion("8.0.46-commercial")?.version).toBe("8.0.46");
    expect(parseMysqlServerVersion("5.5.64-MariaDB")?.product).toBe("MariaDB");
    expect(parseMysqlServerVersion("5.5.56-MariaDB")?.version).toBe("5.5.56");
    expect(parseMysqlServerVersion("5.5.5-10.5.17-MariaDB-1:10.5.17+maria")?.version).toBe("10.5.17");
  });

  it("does not admit MySQL 4.x without verifiable grants", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("4.1.24");
      return [];
    });
    const result = await adapter.testConnection(config, target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_capability");
    expect(state.calls.some((call) => /CURRENT_USER/i.test(call.statement))).toBe(true);
    expect(state.calls.some((call) => /START TRANSACTION/i.test(call.statement))).toBe(false);
    expect(state.calls.some((call) => /SHOW GRANTS FOR CURRENT_USER/i.test(call.statement))).toBe(true);
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

  it("accepts MySQL 4.1 only after verifying SELECT-only grants", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("4.1.24");
      if (/SHOW GRANTS FOR CURRENT_USER/i.test(statement)) {
        return [
          { "Grants for reader@%": "GRANT USAGE ON *.* TO 'reader'@'%'" },
          { "Grants for reader@%": "GRANT SELECT ON `inventory`.* TO 'reader'@'%'" },
        ];
      }
      return [];
    });
    const result = await adapter.testConnection(config, target);
    expect(result).toMatchObject({
      ok: true,
      value: { serverProduct: "MySQL", serverVersion: "4.1.24" },
    });
    expect(state.calls.some((call) => /SHOW GRANTS FOR CURRENT_USER/i.test(call.statement))).toBe(true);
    expect(state.calls.some((call) => /START TRANSACTION READ ONLY/i.test(call.statement))).toBe(false);
    expect(state.closed).toBe(1);
  });

  it("uses verified compatibility mode for MariaDB 5.5 without READ ONLY transactions", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("5.5.64-MariaDB");
      if (/START TRANSACTION READ ONLY/i.test(statement)) throw new Error("syntax error near READ ONLY");
      if (/SHOW GRANTS FOR CURRENT_USER/i.test(statement)) {
        return [{ "Grants for reader@%": "GRANT SELECT ON `inventory`.* TO 'reader'@'%'" }];
      }
      return [];
    });
    const result = await adapter.testConnection(config, target);
    expect(result).toMatchObject({
      ok: true,
      value: { serverProduct: "MariaDB", serverVersion: "5.5.64" },
    });
    expect(state.calls.some((call) => /SHOW GRANTS FOR CURRENT_USER/i.test(call.statement))).toBe(true);
    expect(state.closed).toBe(1);
  });

  for (const grant of [
    "GRANT INSERT ON `inventory`.* TO 'reader'@'%'",
    "GRANT UPDATE ON `inventory`.* TO 'reader'@'%'",
    "GRANT DELETE ON `inventory`.* TO 'reader'@'%'",
    "GRANT CREATE ON `inventory`.* TO 'reader'@'%'",
    "GRANT DROP ON `inventory`.* TO 'reader'@'%'",
    "GRANT ALTER ON `inventory`.* TO 'reader'@'%'",
    "GRANT FILE ON *.* TO 'reader'@'%'",
    "GRANT EXECUTE ON *.* TO 'reader'@'%'",
    "GRANT SELECT ON `inventory`.* TO 'reader'@'%' WITH GRANT OPTION",
    "GRANT SOMETHING_NEW ON *.* TO 'reader'@'%'",
    "GRANT SELECT ON *.* TO 'reader'@'%' WITH SOMETHING_NEW 1",
    "this is not a grant",
  ]) {
    it(`rejects an unsafe or malformed legacy grant: ${grant.slice(0, 42)}`, async () => {
      const { adapter, state } = adapterWith((statement) => {
        if (/SELECT VERSION/i.test(statement)) return identity("4.1.24");
        if (/SHOW GRANTS FOR CURRENT_USER/i.test(statement)) return [{ grant }];
        return [];
      });
      const result = await adapter.testConnection(config, target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("unsupported_capability");
      expect(JSON.stringify(result)).not.toContain(grant);
      expect(state.closed).toBe(1);
    });
  }
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
  it("destroys the dedicated connection when the client deadline fires", async () => {
    const state: FakeState = { calls: [], closed: 0, destroyed: 0 };
    const client: MysqlSqlClient = {
      query(statement) {
        state.calls.push({ statement });
        return new Promise(() => {});
      },
      async end() { state.closed++; },
      destroy() { state.destroyed++; },
    };
    await expect(queryMysqlWithTimeout(client, "SELECT 1", undefined, 1)).rejects.toThrow("timeout");
    expect(state.destroyed).toBe(1);
  });

  it("destroys and closes the adapter connection after a user-query timeout", async () => {
    const { client, state } = fakeClient((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("8.0.46");
      if (/AS `_capped`/i.test(statement)) return new Promise(() => {});
      return [];
    });
    client.statementTimeoutMs = 1;
    const result = await createMysqlAdapter(() => client).executeReadOnly(config, target, "SELECT 1");
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(state.destroyed).toBe(1);
    expect(state.calls.at(-1)?.statement).toBe("ROLLBACK");
    expect(state.closed).toBe(1);
  });

  it("validates the configured database against SHOW DATABASES", async () => {
    const { client, state } = fakeClient(() => [], "another_database");
    const result = await createMysqlAdapter(() => client).testConnection(config, target);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_configuration", field: "database" },
    });
    expect(state.calls.some((call) => /^SHOW DATABASES$/i.test(call.statement))).toBe(true);
    expect(state.calls.some((call) => /^USE /i.test(call.statement))).toBe(false);
    expect(state.closed).toBe(1);
  });

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

  it("classifies mysql2 authentication failures without returning driver details", async () => {
    const error = Object.assign(new Error("Access denied for user 'reader'@'10.0.0.1' (using password: YES)"), {
      code: "ER_ACCESS_DENIED_ERROR",
      errno: 1045,
      sqlState: "28000",
    });
    const result = await createMysqlAdapter(async () => { throw error; }).testConnection(config, target);
    expect(result).toEqual({
      ok: false,
      error: { code: "authentication_failed", message: "Database authentication failed" },
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

  it("discovers a MySQL 4.1 catalog with escaped SHOW statements", async () => {
    const legacyConfig = { ...config, database: "odd`catalog" };
    const { client, state } = fakeClient((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("4.1.24", legacyConfig.database);
      if (/SHOW GRANTS FOR CURRENT_USER/i.test(statement)) {
        return [{ grant: "GRANT SELECT ON *.* TO 'reader'@'%'" }];
      }
      if (/SHOW TABLE STATUS/i.test(statement)) {
        return [{ Name: "order`items", Engine: "MyISAM", Rows: 2, Comment: "orders" }];
      }
      if (/SHOW FULL COLUMNS/i.test(statement)) {
        return [
          { Field: "id", Type: "int(11)", Null: "NO", Key: "PRI", Comment: "" },
          { Field: "order_id", Type: "int(11)", Null: "YES", Key: "MUL", Comment: "" },
        ];
      }
      if (/SHOW INDEX/i.test(statement)) {
        return [{ Table: "order`items", Non_unique: 0, Key_name: "PRIMARY", Seq_in_index: 1, Column_name: "id", Sub_part: null, Collation: "A" }];
      }
      if (/SHOW CREATE TABLE/i.test(statement)) {
        return [{
          Table: "order`items",
          "Create Table": "CREATE TABLE `order``items` (`id` int(11), `order_id` int(11), CONSTRAINT `fk_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))",
        }];
      }
      return [];
    }, legacyConfig.database);
    const adapter = createMysqlAdapter(() => client);
    const stages: string[] = [];
    const result = await adapter.fetchCatalog(legacyConfig, target, (stage) => stages.push(stage.step));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tables[0]).toMatchObject({ schemaName: "odd`catalog", name: "order`items" });
      expect(result.value.primaryKeys).toEqual([{ schemaName: "odd`catalog", tableName: "order`items", columnName: "id" }]);
      expect(result.value.foreignKeys).toEqual([{
        schemaName: "odd`catalog",
        tableName: "order`items",
        columnName: "order_id",
        refSchema: "odd`catalog",
        refTable: "orders",
        refColumn: "id",
      }]);
    }
    expect(stages).toEqual(["tables", "columns", "primaryKeys", "foreignKeys", "indexes"]);
    expect(state.calls.some((call) => call.statement.includes("`odd``catalog`"))).toBe(true);
    expect(state.calls.some((call) => call.statement.includes("`order``items`"))).toBe(true);
    expect(state.closed).toBe(1);
  });

  it("fails closed instead of inventing unparseable legacy foreign keys", async () => {
    const { adapter, state } = adapterWith((statement) => {
      if (/SELECT VERSION/i.test(statement)) return identity("4.1.24");
      if (/SHOW GRANTS FOR CURRENT_USER/i.test(statement)) {
        return [{ grant: "GRANT SELECT ON `inventory`.* TO 'reader'@'%'" }];
      }
      if (/SHOW TABLE STATUS/i.test(statement)) return [{ Name: "items", Rows: 1 }];
      if (/SHOW FULL COLUMNS/i.test(statement)) return [{ Field: "id", Type: "int", Null: "NO", Key: "PRI" }];
      if (/SHOW CREATE TABLE/i.test(statement)) {
        return [{ "Create Table": "CREATE TABLE `items` (`id` int, FOREIGN KEY (id) REFERENCES orders (id))" }];
      }
      return [];
    });
    const result = await adapter.fetchCatalog(config, target);
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_capability" } });
    expect(state.closed).toBe(1);
  });
});
