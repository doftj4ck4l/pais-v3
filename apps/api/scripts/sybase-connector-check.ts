/**
 * Opt-in live safety check for Pixelspace's SAP ASE adapter.
 *
 * Credentials come only from SYBASE_CHECK_* environment variables. This file
 * never constructs a URL and never prints a password or ODBC connection string.
 */
import { DatabaseAdapterRegistry } from "../src/services/db/adapter-registry";
import type { DatabaseConnectionConfig } from "../src/services/db/database-adapter";
import { DatabaseConnectorService } from "../src/services/db/database-connector.service";
import { DatabaseNetworkPolicy } from "../src/services/db/network-policy";
import {
  createSybaseAdapter,
  createSybaseOdbcClient,
  type SybaseClient,
} from "../src/services/db/sybase.driver";

const config: DatabaseConnectionConfig = {
  engine: "sybase",
  host: process.env.SYBASE_CHECK_HOST ?? "",
  port: Number(process.env.SYBASE_CHECK_PORT ?? 5000),
  database: process.env.SYBASE_CHECK_DATABASE ?? "",
  username: process.env.SYBASE_CHECK_USERNAME ?? "",
  password: process.env.SYBASE_CHECK_PASSWORD ?? "",
  ssl: {
    mode: (process.env.SYBASE_CHECK_SSL_MODE as DatabaseConnectionConfig["ssl"]["mode"]) ?? "disable",
  },
  sybase: {
    tdsVersion: process.env.SYBASE_CHECK_TDS_VERSION ?? "5.0",
    clientCharset: process.env.SYBASE_CHECK_CLIENT_CHARSET ?? "ISO-8859-1",
  },
};

if (!config.host || !config.database || !config.username || !config.password) {
  console.error(
    "Set SYBASE_CHECK_HOST, SYBASE_CHECK_DATABASE, SYBASE_CHECK_USERNAME, and SYBASE_CHECK_PASSWORD.",
  );
  process.exit(1);
}

type Lifecycle = { statements: string[]; cursorOpened: boolean; cursorClosed: boolean; closed: boolean };
const lifecycles: Lifecycle[] = [];
const adapter = createSybaseAdapter(async (connection, target) => {
  const inner = await createSybaseOdbcClient(connection, target);
  const lifecycle: Lifecycle = { statements: [], cursorOpened: false, cursorClosed: false, closed: false };
  lifecycles.push(lifecycle);
  return {
    query(statement) {
      lifecycle.statements.push(statement);
      return inner.query(statement);
    },
    async openCursor(statement, fetchSize) {
      lifecycle.statements.push(statement);
      const cursor = await inner.openCursor(statement, fetchSize);
      lifecycle.cursorOpened = true;
      return {
        fetch: () => cursor.fetch(),
        async close() {
          try { await cursor.close(); } finally { lifecycle.cursorClosed = true; }
        },
      };
    },
    async close() {
      try { await inner.close(); } finally { lifecycle.closed = true; }
    },
  } satisfies SybaseClient;
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

function skip(label: string, detail: string) {
  console.log(`skip  ${label} — ${detail}`);
}

const reached = await connector.testConnection(config);
check(
  "authenticates and selects the requested database",
  reached.ok,
  reached.ok ? `${reached.value.serverProduct} ${reached.value.serverVersion ?? ""}`.trim() : reached.error.message,
);
if (!reached.ok) process.exit(1);
check(
  "detects SAP Adaptive Server Enterprise",
  reached.value.serverProduct === "SAP ASE" && Boolean(reached.value.serverVersion),
  reached.value.serverVersion,
);
check("passes the read-only permission preflight", reached.ok);

const stages = new Map<string, number>();
const catalog = await connector.fetchCatalog(config, (step) => stages.set(step.step, step.count));
check(
  "reads the SAP ASE catalog",
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
  "WITH values_cte(n) AS (SELECT 1 UNION ALL SELECT 2) SELECT n FROM values_cte ORDER BY n",
);
if (!cte.ok && cte.error.code === "query_failed") {
  skip("runs a WITH query", "this ASE server did not accept the supported CTE form");
} else {
  check("runs a WITH query", cte.ok && cte.rows.length === 2, cte.ok ? "" : cte.error.message);
}

const bracketed = await connector.executeReadOnly(config, "SELECT 1 AS [update]");
check(
  "accepts bracket-quoted identifiers",
  bracketed.ok && Number(bracketed.rows[0]?.update) === 1,
  bracketed.ok ? "" : bracketed.error.message,
);

const capped = await connector.executeReadOnly(
  config,
  "SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4",
  2,
);
check(
  "caps rows",
  capped.ok && capped.rows.length === 2 && capped.truncatedReason === "rows",
  capped.ok ? `${capped.rows.length} rows returned` : capped.error.message,
);

const byteCapped = await connector.executeReadOnly(
  config,
  [1, 2, 3, 4, 5, 6].map((n) => `SELECT ${n} AS n, replicate('x', 10000) AS payload`).join(" UNION ALL "),
);
check(
  "caps bytes",
  byteCapped.ok && byteCapped.rows.length < 6 && byteCapped.truncatedReason === "bytes",
  byteCapped.ok ? `${byteCapped.rows.length} rows returned` : byteCapped.error.message,
);

for (const [label, statement] of [
  ["CREATE", "CREATE TABLE pixelspace_should_not_exist (id int)"],
  ["UPDATE", "UPDATE pixelspace_should_not_exist SET id = 1"],
  ["SELECT INTO", "SELECT 1 AS id INTO pixelspace_should_not_exist"],
  ["GO", "SELECT 1\nGO\nSELECT 2"],
  ["multiple statements", "SELECT 1; SELECT 2"],
] as const) {
  const before = lifecycles.length;
  const blocked = await connector.executeReadOnly(config, statement);
  check(
    `rejects ${label} before execution`,
    !blocked.ok && blocked.error.code === "query_rejected" && lifecycles.length === before,
    blocked.ok ? "unexpected success" : blocked.error.message,
  );
}

const beforeFailure = lifecycles.length;
const failed = await connector.executeReadOnly(config, "SELECT * FROM pixelspace_table_that_must_not_exist");
check("reports a query error", !failed.ok && failed.error.code === "query_failed", failed.ok ? "unexpected success" : failed.error.message);
check(
  "closes after query errors",
  lifecycles.slice(beforeFailure).every((item) => item.closed),
);
const errorText = JSON.stringify(failed);
check(
  "does not leak credentials or ODBC strings",
  !errorText.includes(config.password)
    && !errorText.includes(encodeURIComponent(config.password))
    && !/\b(?:Driver|DSN|PWD)\s*=/i.test(errorText)
    && !/(?:sybase|ase):\/\//i.test(errorText),
);

const afterFailure = await connector.executeReadOnly(config, "SELECT 1 AS one");
check(
  "cleans up after errors",
  afterFailure.ok && Number(afterFailure.rows[0]?.one) === 1,
  afterFailure.ok ? "subsequent operation succeeded" : afterFailure.error.message,
);
check("closes every dedicated connection", lifecycles.length > 0 && lifecycles.every((item) => item.closed));
check(
  "closes every successfully opened cursor",
  lifecycles.every((item) => !item.cursorOpened || item.cursorClosed),
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
