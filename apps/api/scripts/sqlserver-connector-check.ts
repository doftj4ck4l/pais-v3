/**
 * Opt-in live safety check for Pixelspace's SQL Server adapter.
 *
 * Credentials come only from SQLSERVER_CHECK_* environment variables. This
 * script never constructs or prints a connection URL or the password.
 */
import { createRequire } from "node:module";
import { DatabaseAdapterRegistry } from "../src/services/db/adapter-registry";
import type { DatabaseConnectionConfig } from "../src/services/db/database-adapter";
import { DatabaseConnectorService } from "../src/services/db/database-connector.service";
import { DatabaseNetworkPolicy } from "../src/services/db/network-policy";
import {
  createSqlServerAdapter,
  sqlserverConnectionOptions,
  type SqlServerClient,
  type SqlServerRequest,
} from "../src/services/db/sqlserver.driver";

const require = createRequire(import.meta.url);
const mssql = require("mssql") as any;

const config: DatabaseConnectionConfig = {
  engine: "sqlserver",
  host: process.env.SQLSERVER_CHECK_HOST ?? "",
  port: Number(process.env.SQLSERVER_CHECK_PORT ?? 1433),
  database: process.env.SQLSERVER_CHECK_DATABASE ?? "",
  username: process.env.SQLSERVER_CHECK_USERNAME ?? "",
  password: process.env.SQLSERVER_CHECK_PASSWORD ?? "",
  ssl: {
    mode: (process.env.SQLSERVER_CHECK_SSL_MODE as DatabaseConnectionConfig["ssl"]["mode"]) ?? "require",
    ca: process.env.SQLSERVER_CHECK_CA,
    serverName: process.env.SQLSERVER_CHECK_SERVER_NAME,
  },
};

if (!config.host || !config.database || !config.username || !config.password) {
  console.error(
    "Set SQLSERVER_CHECK_HOST, SQLSERVER_CHECK_DATABASE, SQLSERVER_CHECK_USERNAME, and SQLSERVER_CHECK_PASSWORD.",
  );
  process.exit(1);
}

type Lifecycle = { statements: string[]; began: boolean; rolledBack: boolean; closed: boolean };
const lifecycles: Lifecycle[] = [];
const adapter = createSqlServerAdapter((connection, target) => {
  const pool = new mssql.ConnectionPool(sqlserverConnectionOptions(connection, target));
  const lifecycle: Lifecycle = { statements: [], began: false, rolledBack: false, closed: false };
  lifecycles.push(lifecycle);
  const request = (inner: any): SqlServerRequest => ({
    timeout: 10_000,
    query(statement: string) {
      lifecycle.statements.push(statement);
      return inner.query(statement);
    },
  });
  return {
    connect: () => pool.connect(),
    async close() {
      try { await pool.close(); } finally { lifecycle.closed = true; }
    },
    request: () => request(pool.request({ requestTimeout: 10_000 })),
    transaction: () => {
      const transaction = new mssql.Transaction(pool, { requestTimeout: 10_000 });
      return {
        async begin() { await transaction.begin(); lifecycle.began = true; },
        async rollback() {
          try { await transaction.rollback(); } finally { lifecycle.rolledBack = true; }
        },
        request: () => request(new mssql.Request(transaction, { requestTimeout: 10_000 })),
      };
    },
  } satisfies SqlServerClient;
});

const connector = new DatabaseConnectorService(
  new DatabaseAdapterRegistry().register(adapter),
  new DatabaseNetworkPolicy(),
);

let failures = 0;
function check(label: string, passed: boolean, detail = "") {
  console.log(`${passed ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const reached = await connector.testConnection(config);
check(
  "connects and authenticates",
  reached.ok,
  reached.ok ? `${reached.value.serverProduct} ${reached.value.serverVersion ?? ""}`.trim() : reached.error.message,
);
if (!reached.ok) process.exit(1);
check(
  "passes the read-only permission preflight",
  reached.value.serverProduct === "SQL Server" && Boolean(reached.value.serverVersion),
);

const stages = new Map<string, number>();
const catalog = await connector.fetchCatalog(config, (step) => stages.set(step.step, step.count));
check(
  "reads the SQL Server catalog",
  catalog.ok,
  catalog.ok ? `${catalog.value.tables.length} tables/views` : catalog.error.message,
);
for (const stage of ["tables", "columns", "primaryKeys", "foreignKeys", "indexes"] as const) {
  check(`completes catalog stage: ${stage}`, stages.has(stage), `${stages.get(stage) ?? 0} records`);
}

const select = await connector.executeReadOnly(config, "SELECT 1 AS one");
check("runs SELECT 1", select.ok && Number(select.rows[0]?.one) === 1, select.ok ? "" : select.error.message);

const cte = await connector.executeReadOnly(
  config,
  "WITH values_cte AS (SELECT 1 AS n UNION ALL SELECT 2 AS n) SELECT n FROM values_cte ORDER BY n",
);
check("runs a WITH query", cte.ok && cte.rows.length === 2, cte.ok ? "" : cte.error.message);

const bracketed = await connector.executeReadOnly(
  config,
  "SELECT [update] FROM (VALUES (1)) AS sample([update])",
);
check(
  "accepts bracket-quoted identifiers",
  bracketed.ok && Number(bracketed.rows[0]?.update) === 1,
  bracketed.ok ? "" : bracketed.error.message,
);

const capped = await connector.executeReadOnly(
  config,
  "SELECT n FROM (VALUES (1), (2), (3), (4)) AS values_table(n) ORDER BY n",
  2,
);
check(
  "caps rows",
  capped.ok && capped.rows.length === 2 && capped.truncatedReason === "rows",
  capped.ok ? `${capped.rows.length} rows returned` : capped.error.message,
);

const byteCapped = await connector.executeReadOnly(
  config,
  "SELECT REPLICATE(CAST('x' AS varchar(max)), 60000) AS payload",
);
check(
  "caps bytes",
  byteCapped.ok && byteCapped.rows.length === 0 && byteCapped.truncatedReason === "bytes",
  byteCapped.ok ? `${byteCapped.rows.length} rows returned` : byteCapped.error.message,
);

for (const [label, statement] of [
  ["CREATE", "CREATE TABLE pixelspace_should_not_exist (id int)"],
  ["UPDATE", "UPDATE pixelspace_should_not_exist SET id = 1"],
  ["SELECT INTO", "SELECT 1 AS id INTO pixelspace_should_not_exist"],
  ["multiple statements", "SELECT 1; SELECT 2"],
] as const) {
  const blocked = await connector.executeReadOnly(config, statement);
  check(
    `rejects ${label} before execution`,
    !blocked.ok && blocked.error.code === "query_rejected",
    blocked.ok ? "unexpected success" : blocked.error.message,
  );
}

const beforeFailure = lifecycles.length;
const failed = await connector.executeReadOnly(
  config,
  "SELECT * FROM pixelspace_table_that_must_not_exist",
);
check("reports a query error", !failed.ok && failed.error.code === "query_failed", failed.ok ? "unexpected success" : failed.error.message);
check(
  "rolls back and closes after query errors",
  lifecycles.slice(beforeFailure).every((item) => item.began && item.rolledBack && item.closed),
);
const afterFailure = await connector.executeReadOnly(config, "SELECT 1 AS one");
check(
  "cleans up after errors",
  afterFailure.ok && Number(afterFailure.rows[0]?.one) === 1,
  afterFailure.ok ? "subsequent operation succeeded" : afterFailure.error.message,
);
check("closes every dedicated pool", lifecycles.length > 0 && lifecycles.every((item) => item.closed));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
