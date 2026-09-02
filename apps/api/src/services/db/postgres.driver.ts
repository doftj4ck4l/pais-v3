import type {
  ApprovedDatabaseTarget,
  CatalogStep,
  DatabaseAdapter,
  DatabaseConnectionConfig,
  DatabaseError,
  DatabaseResult,
  QueryOutcome,
  RawCatalog,
} from "./database-adapter";
import { scrubDatabaseMessage } from "./database-adapter";
import { blankLiteralsAndComments, guardReadOnly } from "./sql-guard";
import { DATABASE_BYTE_CAP, DATABASE_ROW_CAP } from "./query-policy";

/**
 * Everything that speaks to a user's PostgreSQL server.
 *
 * The engine-specific implementation of the shared database adapter contract.
 * Catalog SQL, transaction syntax, timeout syntax, TLS mapping, error handling,
 * and unsafe PostgreSQL functions stay here so future drivers do not grow an
 * engine-conditional connector.
 */

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema')`;
const STATEMENT_TIMEOUT_MS = 10_000;

/** Rows returned to the model in one query. A caller may lower this, never raise it. */
const ROW_CAP = DATABASE_ROW_CAP;

/**
 * Serialized bytes of row data returned to the model in one query, independent
 * of ROW_CAP. A handful of rows with a wide text/json/bytea column can blow the
 * model's context long before 100 rows accumulate, so this is a second,
 * orthogonal cap — not a derivation of the row cap.
 */
const BYTE_CAP = DATABASE_BYTE_CAP;

/**
 * `max: 1` is load-bearing everywhere below: `runReadOnly` issues BEGIN, the
 * query, and ROLLBACK as separate statements, which are only guaranteed to land
 * on the same backend when the pool holds exactly one connection.
 *
 * `idleTimeout` must stay comfortably above `STATEMENT_TIMEOUT_MS`, not equal
 * to it: the two are a race, and the server's `statement_timeout` has to win
 * it deterministically. It is the layer that also bounds a query the client
 * would otherwise happily wait on — a client-side idle timeout firing first
 * would cut the connection without ever proving the server-side budget works,
 * and on a slow or congested network the race could go either way run to run.
 */
function tlsOptions(config: DatabaseConnectionConfig, target: ApprovedDatabaseTarget) {
  if (config.ssl.mode === "disable") return false;
  if (config.ssl.mode === "require") {
    return { rejectUnauthorized: false, serverName: config.ssl.serverName || target.originalHost };
  }
  return {
    rejectUnauthorized: true,
    serverName: config.ssl.serverName || target.originalHost,
    ...(config.ssl.ca ? { ca: config.ssl.ca } : {}),
  };
}

function client(config: DatabaseConnectionConfig, target: ApprovedDatabaseTarget): any {
  return new Bun.SQL({
    adapter: "postgres",
    hostname: target.address,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    tls: tlsOptions(config, target),
    max: 1,
    idleTimeout: 30,
    connectionTimeout: 10,
  });
}

/**
 * Never let a driver error carry the credential into a log or a tool result.
 *
 * Two things make this harder than a single string replace:
 *
 * - `URL.password` is percent-encoded (WHATWG URL semantics), but a driver
 *   error may quote the connection string with the password decoded — a
 *   generated password containing `@`, `%`, `#`, or `/` will not match the
 *   encoded form. Both forms are scrubbed.
 * - A malformed URL can still carry credentials verbatim in its text (it
 *   just doesn't parse). Falling back to silence would leak them, so the
 *   catch branch strips any userinfo-shaped segment instead.
 * - A Postgres URI can also carry the password as a `?password=...` query
 *   parameter (`Bun.SQL` honours it — confirmed live: a URL with a bogus
 *   userinfo password but a correct `?password=` connects). Destinations are
 *   the server log and the browser tooltip, same as the userinfo password,
 *   so it is scrubbed the same way — encoded and decoded form both.
 *
 * The connector also applies the shared scrubber at its boundary, so this
 * driver-local pass is defence in depth for errors originating inside Bun.SQL.
 */
function scrub(message: string, config: Pick<DatabaseConnectionConfig, "password">): string {
  return scrubDatabaseMessage(message, config, "postgresql://***");
}

function databaseError(
  error: unknown,
  config: DatabaseConnectionConfig,
  fallback: DatabaseError["code"],
): DatabaseError {
  const message = scrub(error instanceof Error ? error.message : String(error), config);
  if (/statement timeout|timed out|timeout/i.test(message)) {
    return { code: "timeout", message: "Database statement timeout", retryable: true };
  }
  if (/password authentication failed|authentication failed|28P01/i.test(message)) {
    return { code: "authentication_failed", message: "Database authentication failed" };
  }
  return {
    code: fallback,
    message: fallback === "connection_failed" ? "Could not connect to the database" : message,
    retryable: fallback === "connection_failed",
  };
}

/**
 * Coerce and clamp the caller-supplied cap. The only invariant that matters:
 * for every input — negative, zero, fractional, NaN, Infinity, or absurdly
 * large — the result can only ever LOWER ROW_CAP, never raise it.
 */
export function boundCap(cap: number): number {
  const finite = Number.isFinite(cap) ? Math.floor(cap) : ROW_CAP;
  return Math.max(1, Math.min(ROW_CAP, finite));
}

/**
 * `JSON.stringify` throws on a `bigint` (a real value for a Postgres `bigint`
 * column), which would turn a byte-budget check into a 500 on exactly the
 * wide-row queries this budget exists to catch. This is only used to size a
 * row for the budget, not to build what is sent to the model.
 */
function serializeForSize(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

async function testConnection(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
): Promise<DatabaseResult<{
  serverVersion?: string;
  serverProduct?: "PostgreSQL";
}>> {
  let sql: any;
  let inTransaction = false;
  try {
    sql = client(config, target);
    await sql.unsafe("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    await sql.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const rows = await sql`SELECT current_setting('server_version') AS version`;
    return {
      ok: true,
      value: {
        serverVersion: String(rows[0]?.version ?? "") || undefined,
        serverProduct: "PostgreSQL",
      },
    };
  } catch (error) {
    return { ok: false, error: databaseError(error, config, "connection_failed") };
  } finally {
    if (inTransaction) await sql.unsafe("ROLLBACK").catch(() => {});
    if (sql) await sql.close().catch(() => {});
  }
}

/**
 * `onStep` reports each catalog query as it completes.
 *
 * Introspection is five sequential round trips and, against a remote database
 * with a wide schema, the slow part of attaching a connection. Reporting per
 * query is the finest granularity available without splitting a single query,
 * and it is what lets the console show progress rather than a spinner.
 */
async function fetchCatalog(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
  onStep?: (step: CatalogStep) => void,
): Promise<DatabaseResult<RawCatalog>> {
  // Constructed inside the try: see `probe` for why.
  let sql: any;
  let inTransaction = false;
  try {
    sql = client(config, target);
    await sql.unsafe("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    await sql.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const tables = await sql.unsafe(`
      SELECT n.nspname AS "schemaName",
             c.relname AS "name",
             obj_description(c.oid) AS "comment",
             GREATEST(c.reltuples, 0)::bigint AS "rowEstimate"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname, c.relname
    `);
    onStep?.({ step: "tables", count: tables.length });

    const columns = await sql.unsafe(`
      SELECT n.nspname AS "schemaName",
             c.relname AS "tableName",
             a.attnum   AS "seq",
             a.attname  AS "name",
             format_type(a.atttypid, a.atttypmod) AS "dataType",
             NOT a.attnotnull AS "nullable",
             col_description(c.oid, a.attnum) AS "comment"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
      ORDER BY n.nspname, c.relname, a.attnum
    `);
    onStep?.({ step: "columns", count: columns.length });

    const primaryKeys = await sql.unsafe(`
      SELECT n.nspname AS "schemaName",
             c.relname AS "tableName",
             a.attname AS "columnName"
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(k.conkey) AS ck(attnum) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
      WHERE k.contype = 'p' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    `);
    onStep?.({ step: "primaryKeys", count: primaryKeys.length });

    const foreignKeys = await sql.unsafe(`
      SELECT n.nspname   AS "schemaName",
             c.relname   AS "tableName",
             a.attname   AS "columnName",
             fn.nspname  AS "refSchema",
             fc.relname  AS "refTable",
             fa.attname  AS "refColumn"
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class fc ON fc.oid = k.confrelid
      JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      JOIN generate_subscripts(k.conkey, 1) AS i ON TRUE
      JOIN pg_attribute a  ON a.attrelid  = c.oid  AND a.attnum  = k.conkey[i]
      JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = k.confkey[i]
      WHERE k.contype = 'f' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    `);
    onStep?.({ step: "foreignKeys", count: foreignKeys.length });

    const indexes = await sql.unsafe(`
      SELECT schemaname AS "schemaName",
             tablename  AS "tableName",
             indexdef   AS "definition"
      FROM pg_indexes
      WHERE schemaname NOT IN ${SYSTEM_SCHEMAS}
        AND schemaname NOT LIKE 'pg_toast%'
    `);
    onStep?.({ step: "indexes", count: indexes.length });

    return {
      ok: true,
      value: {
        tables: tables.map((t: any) => ({ ...t, rowEstimate: Number(t.rowEstimate) })),
        columns,
        primaryKeys,
        foreignKeys,
        indexes,
      },
    };
  } catch (error) {
    return { ok: false, error: databaseError(error, config, "connection_failed") };
  } finally {
    if (inTransaction) await sql.unsafe("ROLLBACK").catch(() => {});
    if (sql) await sql.close().catch(() => {});
  }
}

/**
 * Run one statement under four layers of protection.
 *
 * The guard is layer 2 and gives the model a correctable error. `BEGIN
 * TRANSACTION READ ONLY` is layer 3 and is the actual guarantee — it holds even
 * for a data-modifying CTE the guard failed to spot. Layer 4 is the timeout and
 * the row cap.
 *
 * The cap is applied by wrapping the statement in a subquery rather than by
 * appending LIMIT, which would attach to the wrong clause in a compound query.
 * One extra row is fetched so truncation can be reported without a COUNT.
 * `guardReadOnly` returns the statement with comments intact, so the closing
 * paren and LIMIT go on their own line — otherwise a trailing `-- comment` in
 * agent-written SQL (routine in LLM output) would comment out both.
 */
const UNSAFE_POSTGRES_FUNCTIONS = [
  "dblink",
  "dblink_exec",
  "lo_export",
  "lo_create",
  "lo_creat",
  "lo_import",
  "lo_open",
  "lo_truncate",
  "lo_unlink",
  "lowrite",
  "nextval",
  "setval",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_cancel_backend",
  "pg_log_backend_memory_contexts",
  "pg_logical_emit_message",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_tmpdir",
  "pg_ls_waldir",
  "pg_notify",
  "pg_promote",
  "pg_read_binary_file",
  "pg_read_file",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_stat_file",
  "pg_terminate_backend",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "set_config",
  "pg_wal_replay_pause",
  "pg_wal_replay_resume",
  "pg_switch_wal",
];

const UNSAFE_POSTGRES_FUNCTION_PATTERNS = UNSAFE_POSTGRES_FUNCTIONS.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\s*\\(`, "i"),
}));

export function guardPostgresqlFunctions(sql: string): DatabaseError | null {
  const inspected = blankLiteralsAndComments(sql, { preserveQuotedIdentifiers: true });
  if (!inspected.ok) {
    return { code: "query_rejected", message: "Statement contains an unterminated string or comment" };
  }
  if (/\bU&"/i.test(inspected.blanked)) {
    return { code: "query_rejected", message: "Unicode-escaped PostgreSQL identifiers are not permitted" };
  }
  const functionScan = inspected.blanked.replaceAll('"', " ");
  for (const { name, pattern } of UNSAFE_POSTGRES_FUNCTION_PATTERNS) {
    if (pattern.test(functionScan)) {
      return { code: "query_rejected", message: `PostgreSQL function ${name} is not permitted` };
    }
  }
  return null;
}

async function runReadOnly(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
  rawSql: string,
  cap: number = ROW_CAP,
): Promise<QueryOutcome> {
  const guarded = guardReadOnly(rawSql);
  if (!guarded.ok) {
    return { ok: false, error: { code: "query_rejected", message: guarded.reason } };
  }
  const unsafeFunction = guardPostgresqlFunctions(guarded.sql);
  if (unsafeFunction) return { ok: false, error: unsafeFunction };

  const bounded = boundCap(cap);
  // `isExplain` is a fact the guard already decided against the blanked
  // (comment/literal-free) text — re-deriving it here from `guarded.sql`
  // (raw text) is exactly the bug this fix removes: a leading block comment
  // before EXPLAIN reads as "not EXPLAIN" to a regex over raw text.
  const isExplain = guarded.isExplain;
  const statement = isExplain
    ? guarded.sql
    : `SELECT * FROM (\n${guarded.sql}\n) AS _capped LIMIT ${bounded + 1}`;

  // Constructed inside the try: see `probe` for why.
  let sql: any;
  let inTransaction = false;
  try {
    sql = client(config, target);
    await sql.unsafe("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    await sql.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    const rows: Record<string, unknown>[] = await sql.unsafe(statement);
    const rowCapped = !isExplain && rows.length > bounded;
    const rowLimited = rowCapped ? rows.slice(0, bounded) : rows;

    // Byte budget applies AFTER the row cap (so a query already trimmed to
    // `bounded` rows is what gets measured) but is not exempt for EXPLAIN —
    // an EXPLAIN plan is itself unbounded and can be large. An individually
    // oversized row is omitted: returning it whole would make the byte ceiling
    // advisory instead of an enforced result limit.
    let bytes = 0;
    let byteCapped = false;
    const shown: Record<string, unknown>[] = [];
    for (const row of rowLimited) {
      const size = Buffer.byteLength(serializeForSize(row));
      if (bytes + size > BYTE_CAP) {
        byteCapped = true;
        break;
      }
      shown.push(row);
      bytes += size;
    }

    const truncated = rowCapped || byteCapped;
    const truncatedReason: "rows" | "bytes" | null = byteCapped ? "bytes" : rowCapped ? "rows" : null;

    return {
      ok: true,
      columns: rowLimited.length ? Object.keys(rowLimited[0]!) : [],
      rows: shown,
      truncated,
      truncatedReason,
    };
  } catch (error) {
    return { ok: false, error: databaseError(error, config, "query_failed") };
  } finally {
    if (inTransaction) await sql.unsafe("ROLLBACK").catch(() => {});
    if (sql) await sql.close().catch(() => {});
  }
}

function validate(config: DatabaseConnectionConfig): DatabaseError | null {
  if (config.engine !== "postgresql") {
    return { code: "unsupported_engine", message: "PostgreSQL adapter received another engine", field: "engine" };
  }
  if (!config.host.trim()) return { code: "invalid_configuration", message: "Host is required", field: "host" };
  if (config.host.length > 253 || /[\0\r\n]/.test(config.host)) {
    return { code: "invalid_configuration", message: "Host is invalid", field: "host" };
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    return { code: "invalid_configuration", message: "Port must be between 1 and 65535", field: "port" };
  }
  if (!config.database.trim()) {
    return { code: "invalid_configuration", message: "Database name is required", field: "database" };
  }
  if (config.database.length > 128 || /[\0\r\n]/.test(config.database)) {
    return { code: "invalid_configuration", message: "Database name is invalid", field: "database" };
  }
  if (!config.username.trim()) {
    return { code: "invalid_configuration", message: "Username is required", field: "username" };
  }
  if (config.username.length > 128 || /[\0\r\n]/.test(config.username)) {
    return { code: "invalid_configuration", message: "Username is invalid", field: "username" };
  }
  if (!config.password) {
    return { code: "invalid_configuration", message: "Password is required", field: "password" };
  }
  if (config.password.length > 4096 || config.password.includes("\0")) {
    return { code: "invalid_configuration", message: "Password is invalid", field: "password" };
  }
  if (!["disable", "require", "verify-full"].includes(config.ssl.mode)) {
    return { code: "invalid_configuration", message: "Unsupported PostgreSQL SSL mode", field: "ssl.mode" };
  }
  if (config.ssl.ca && config.ssl.ca.length > 131_072) {
    return { code: "invalid_configuration", message: "Custom CA is too large", field: "ssl.ca" };
  }
  if (config.ssl.serverName && (config.ssl.serverName.length > 253 || /[\s/\\\0]/.test(config.ssl.serverName))) {
    return { code: "invalid_configuration", message: "TLS server name is invalid", field: "ssl.serverName" };
  }
  return null;
}

export const postgresqlAdapter: DatabaseAdapter = {
  engine: "postgresql",
  defaultPort: 5432,
  capabilities: {
    schemas: true,
    explain: true,
    sslModes: ["disable", "require", "verify-full"],
    readOnlyTransactions: true,
    statementTimeout: true,
  },
  validate,
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  testConnection,
  fetchCatalog,
  executeReadOnly: runReadOnly,
};
