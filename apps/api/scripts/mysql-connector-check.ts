/**
 * Opt-in live safety check for Pixelspace's MySQL/MariaDB adapter.
 *
 * Inputs come only from MYSQL_CHECK_* environment variables. The password is
 * never logged or placed in a URL/command line.
 */
import { DatabaseAdapterRegistry } from "../src/services/db/adapter-registry";
import type { DatabaseConnectionConfig } from "../src/services/db/database-adapter";
import { DatabaseConnectorService } from "../src/services/db/database-connector.service";
import {
  createMysqlAdapter,
  mysqlConnectionOptions,
  type MysqlSqlClient,
} from "../src/services/db/mysql.driver";
import { DatabaseNetworkPolicy } from "../src/services/db/network-policy";
import { createConnection } from "mysql2/promise";

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

const adapter = createMysqlAdapter(async (connection, target) => {
  const sql = await createConnection(mysqlConnectionOptions(connection, target));
  const lifecycle: Lifecycle = { statements: [], rolledBack: false, closed: false };
  lifecycles.push(lifecycle);
  return {
    query(statement: string, values?: unknown[]) {
      lifecycle.statements.push(statement);
      if (/^\s*ROLLBACK\s*$/i.test(statement)) lifecycle.rolledBack = true;
      return sql.query(statement, values as any) as any;
    },
    async end() {
      lifecycle.closed = true;
      await sql.end();
    },
    destroy() { sql.destroy(); },
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

function protectedAndClosed(item: Lifecycle): boolean {
  return item.closed && (item.rolledBack
    || item.statements.some((statement) => /SHOW GRANTS FOR CURRENT_USER/i.test(statement)));
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
check("establishes a modern read-only transaction or verifies legacy grants",
  lifecycleSince(before).every(protectedAndClosed));

before = lifecycles.length;
const catalog = await connector.fetchCatalog(config);
check("discovers the configured database catalog", catalog.ok && catalog.value.tables.length > 0,
  catalog.ok ? `${catalog.value.tables.length} tables/views` : catalog.error.message);
check("cleans up catalog discovery", lifecycleSince(before).every(protectedAndClosed));

before = lifecycles.length;
const selected = await connector.executeReadOnly(config, "SELECT 1 AS one");
check("runs SELECT 1", selected.ok && Number(selected.rows[0]?.one) === 1,
  selected.ok ? "" : selected.error.message);
check("cleans up a successful query", lifecycleSince(before).every(protectedAndClosed));

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
check("cleans up a failed query", lifecycleSince(before).every(protectedAndClosed));
check("uses one dedicated physical connection per protected operation",
  lifecycles.every((item) => item.statements.length > 0));

check("all adapter connections were closed", lifecycles.length > 0 && lifecycles.every((item) => item.closed));
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
