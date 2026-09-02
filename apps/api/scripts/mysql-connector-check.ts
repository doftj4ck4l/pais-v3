/**
 * Opt-in live safety check for Pixelspace's MySQL/MariaDB adapter.
 *
 * Inputs come only from MYSQL_CHECK_* environment variables. The password is
 * never logged or placed in a URL/command line.
 */
import { DatabaseAdapterRegistry } from "../src/services/db/adapter-registry";
import type { DatabaseConnectionConfig } from "../src/services/db/database-adapter";
import { redactDatabaseError } from "../src/services/db/database-adapter";
import { DatabaseConnectorService } from "../src/services/db/database-connector.service";
import {
  createMysqlAdapter,
  mysqlTlsOptions,
  type MysqlSqlClient,
} from "../src/services/db/mysql.driver";
import { DatabaseNetworkPolicy } from "../src/services/db/network-policy";

const config: DatabaseConnectionConfig = {
  engine: "mysql",
  host: process.env.MYSQL_CHECK_HOST ?? "",
  port: Number(process.env.MYSQL_CHECK_PORT ?? 3306),
  database: process.env.MYSQL_CHECK_DATABASE ?? "",
  username: process.env.MYSQL_CHECK_USERNAME ?? "",
  password: process.env.MYSQL_CHECK_PASSWORD ?? "",
  ssl: { mode: (process.env.MYSQL_CHECK_SSL_MODE as DatabaseConnectionConfig["ssl"]["mode"]) ?? "disable" },
};

if (!config.host || !config.database || !config.username || !config.password) {
  console.error("Set MYSQL_CHECK_HOST, MYSQL_CHECK_DATABASE, MYSQL_CHECK_USERNAME, and MYSQL_CHECK_PASSWORD.");
  process.exit(1);
}

type Lifecycle = { statements: string[]; rolledBack: boolean; closed: boolean };
const lifecycles: Lifecycle[] = [];

const adapter = createMysqlAdapter((connection, target) => {
  const sql = new Bun.SQL({
    adapter: "mysql",
    hostname: target.address,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    password: connection.password,
    tls: mysqlTlsOptions(connection, target),
    max: 1,
    idleTimeout: 30,
    connectionTimeout: 10,
  });
  const lifecycle: Lifecycle = { statements: [], rolledBack: false, closed: false };
  lifecycles.push(lifecycle);
  return {
    unsafe(statement: string, values?: unknown[]) {
      lifecycle.statements.push(statement);
      if (/^\s*ROLLBACK\s*$/i.test(statement)) lifecycle.rolledBack = true;
      return sql.unsafe(statement, values as any) as any;
    },
    async close(options) {
      lifecycle.closed = true;
      await sql.close(options);
    },
  } satisfies MysqlSqlClient;
});

const networkPolicy = new DatabaseNetworkPolicy();
const connector = new DatabaseConnectorService(
  new DatabaseAdapterRegistry().register(adapter),
  networkPolicy,
);

let failures = 0;
function check(label: string, passed: boolean, detail = "") {
  console.log(`${passed ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

function lifecycleSince(offset: number): Lifecycle[] {
  return lifecycles.slice(offset);
}

let before = lifecycles.length;
const reached = await connector.testConnection(config);
check("authenticates", reached.ok, reached.ok ? "" : reached.error.message);
if (!reached.ok) process.exit(1);
check("reads SELECT VERSION()", Boolean(reached.value.serverVersion), `${reached.value.serverProduct} ${reached.value.serverVersion}`);
check(
  "reads DATABASE() and CURRENT_USER() without exposing authenticatedAs",
  lifecycleSince(before).some((item) => item.statements.some((statement) => /DATABASE\(\).*CURRENT_USER\(\)/s.test(statement))) &&
    !JSON.stringify(reached).includes("authenticatedAs"),
);
check("rolls back and closes the connection test", lifecycleSince(before).every((item) => item.rolledBack && item.closed));

before = lifecycles.length;
const catalog = await connector.fetchCatalog(config);
check("discovers the configured database catalog", catalog.ok && catalog.value.tables.length > 0,
  catalog.ok ? `${catalog.value.tables.length} tables/views` : catalog.error.message);
check("rolls back and closes catalog discovery", lifecycleSince(before).every((item) => item.rolledBack && item.closed));

before = lifecycles.length;
const selected = await connector.executeReadOnly(config, "SELECT 1 AS one");
check("runs SELECT 1", selected.ok && Number(selected.rows[0]?.one) === 1,
  selected.ok ? "" : selected.error.message);
check("rolls back and closes a successful query", lifecycleSince(before).every((item) => item.rolledBack && item.closed));

const capped = await connector.executeReadOnly(
  config,
  "SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4",
  2,
);
check("limits rows", capped.ok && capped.rows.length === 2 && capped.truncated && capped.truncatedReason === "rows",
  capped.ok ? `${capped.rows.length} rows returned` : capped.error.message);

const byteCapped = await connector.executeReadOnly(config, "SELECT REPEAT('x', 60000) AS payload");
check("limits bytes", byteCapped.ok && byteCapped.rows.length === 0 && byteCapped.truncatedReason === "bytes",
  byteCapped.ok ? `${byteCapped.rows.length} rows returned` : byteCapped.error.message);

const write = await connector.executeReadOnly(config, "CREATE TABLE pixelspace_connector_write_probe (id INT)");
check("rejects writes before network execution", !write.ok && write.error.code === "query_rejected");
const multiple = await connector.executeReadOnly(config, "SELECT 1; SELECT 2");
check("rejects multiple statements", !multiple.ok && multiple.error.code === "query_rejected");

before = lifecycles.length;
const failed = await connector.executeReadOnly(config, "SELECT * FROM pixelspace_table_that_must_not_exist");
check("reports query failure", !failed.ok && failed.error.code === "query_failed",
  failed.ok ? "unexpected success" : failed.error.message);
check("rolls back and closes a failed query", lifecycleSince(before).every((item) => item.rolledBack && item.closed));

const approved = await networkPolicy.approve(config.host);
if (!approved.ok) throw new Error(approved.error.message);
let readOnlyRejected = false;
let readOnlyDetail = "";
let connectionAtStart: unknown;
let connectionAtEnd: unknown;
const probeTable = catalog.ok ? catalog.value.tables[0] : undefined;
const probeColumn = probeTable && catalog.ok
  ? catalog.value.columns.find((column) =>
      column.schemaName === probeTable.schemaName && column.tableName === probeTable.name)
  : undefined;
let direct: InstanceType<typeof Bun.SQL> | undefined;
try {
  direct = new Bun.SQL({
    adapter: "mysql",
    hostname: approved.value.address,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    tls: mysqlTlsOptions(config, approved.value),
    max: 1,
    connectionTimeout: 10,
  });
  await direct.unsafe("START TRANSACTION READ ONLY");
  connectionAtStart = (await direct.unsafe("SELECT CONNECTION_ID() AS id"))[0]?.id;
  if (!probeTable || !probeColumn) {
    readOnlyDetail = "Catalog has no table column available for the no-op write probe";
  } else try {
    const schema = adapter.quoteIdentifier(probeTable.schemaName);
    const table = adapter.quoteIdentifier(probeTable.name);
    const column = adapter.quoteIdentifier(probeColumn.name);
    await direct.unsafe(`UPDATE ${schema}.${table} SET ${column} = ${column} WHERE 1 = 0`);
  } catch (error) {
    readOnlyDetail = redactDatabaseError({
      code: "query_failed",
      message: error instanceof Error ? error.message : String(error),
    }, config).message;
    const metadata = error && typeof error === "object"
      ? `${(error as any).code ?? ""} ${(error as any).errno ?? ""} ${(error as any).sqlState ?? ""}`
      : "";
    readOnlyRejected = /1792|25006|read.only transaction/i.test(`${metadata} ${readOnlyDetail}`);
  }
  connectionAtEnd = (await direct.unsafe("SELECT CONNECTION_ID() AS id"))[0]?.id;
} catch (error) {
  readOnlyDetail = redactDatabaseError({
    code: "query_failed",
    message: error instanceof Error ? error.message : String(error),
  }, config).message;
} finally {
  await direct?.unsafe("ROLLBACK").catch(() => {});
  await direct?.close({ timeout: 0 }).catch(() => {});
}
check("server-enforced READ ONLY transaction rejects a no-op write", readOnlyRejected, readOnlyDetail);
check("one physical connection carries transaction, query, and rollback",
  connectionAtStart != null && String(connectionAtStart) === String(connectionAtEnd));

check("all adapter connections were closed", lifecycles.length > 0 && lifecycles.every((item) => item.closed));
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
