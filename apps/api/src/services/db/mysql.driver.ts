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
import { connect as connectTcp, isIP } from "node:net";
import { createConnection, type ConnectionOptions } from "mysql2/promise";
import { scrubDatabaseMessage } from "./database-adapter";
import { guardReadOnly } from "./sql-guard";
import { DATABASE_BYTE_CAP, DATABASE_ROW_CAP } from "./query-policy";

const STATEMENT_TIMEOUT_MS = 10_000;
const ROW_CAP = DATABASE_ROW_CAP;
const BYTE_CAP = DATABASE_BYTE_CAP;
const MYSQL_SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

export type MysqlSqlClient = {
  query<T = Record<string, unknown>[]>(statement: string, values?: unknown[]): PromiseLike<[T, unknown]>;
  end(): PromiseLike<unknown>;
  destroy(): void;
  /** Test seam; production clients always use the fixed 10-second policy. */
  statementTimeoutMs?: number;
};

export type MysqlClientFactory = (
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
) => MysqlSqlClient | PromiseLike<MysqlSqlClient>;

export type MysqlServerVersion = {
  product: "MySQL" | "MariaDB";
  version: string;
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

class MysqlAdapterError extends Error {
  constructor(readonly databaseError: DatabaseError) {
    super(databaseError.message);
  }
}

class MysqlClientTimeoutError extends Error {
  constructor() { super("Database statement timeout"); }
}

/** MySQL-compatible servers sometimes prefix MariaDB's real version with 5.5.5. */
export function parseMysqlServerVersion(rawValue: unknown): MysqlServerVersion | null {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return null;
  const product = /mariadb/i.test(raw) ? "MariaDB" : "MySQL";
  const relevant = product === "MariaDB" ? raw.slice(0, raw.toLowerCase().lastIndexOf("mariadb")) : raw;
  const matches = [...relevant.matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)];
  const match = product === "MariaDB" ? matches.at(-1) : matches[0];
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  return { product, version: `${major}.${minor}.${patch}`, major, minor, patch, raw };
}

function versionAtLeast(version: MysqlServerVersion, major: number, minor: number, patch = 0): boolean {
  return [version.major, version.minor, version.patch].join(".").localeCompare(
    [major, minor, patch].join("."),
    undefined,
    { numeric: true },
  ) >= 0;
}

export function mysqlTlsOptions(
  config: DatabaseConnectionConfig,
): undefined | { rejectUnauthorized: boolean; verifyIdentity: boolean; ca?: string } {
  if (config.ssl.mode === "disable") return undefined;
  return {
    rejectUnauthorized: config.ssl.mode === "verify-full",
    verifyIdentity: config.ssl.mode === "verify-full",
    ...(config.ssl.mode === "verify-full" && config.ssl.ca ? { ca: config.ssl.ca } : {}),
  };
}

export function mysqlConnectionOptions(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
): ConnectionOptions {
  return {
    // mysql2 derives TLS SNI and identity from `host`. The custom stream keeps
    // DNS rebinding protection intact by dialing only the approved literal IP.
    host: config.ssl.serverName || target.originalHost,
    port: config.port,
    user: config.username,
    password: config.password,
    ssl: mysqlTlsOptions(config),
    stream: () => connectTcp({ host: target.address, port: config.port }),
    connectTimeout: STATEMENT_TIMEOUT_MS,
    multipleStatements: false,
    flags: ["-LOCAL_FILES"],
    supportBigNumbers: true,
    dateStrings: true,
    trace: false,
  };
}

const mysql2Client: MysqlClientFactory = async (config, target) =>
  await createConnection(mysqlConnectionOptions(config, target)) as MysqlSqlClient;

function scrub(message: string, config: Pick<DatabaseConnectionConfig, "password">): string {
  return scrubDatabaseMessage(message, config, "mysql://***");
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { code?: unknown; errno?: unknown; sqlState?: unknown };
  return [value.code, value.errno, value.sqlState].filter(Boolean).join(" ");
}

function databaseError(
  error: unknown,
  config: DatabaseConnectionConfig,
  fallback: DatabaseError["code"],
): DatabaseError {
  if (error instanceof MysqlAdapterError) return error.databaseError;
  if (error instanceof MysqlClientTimeoutError) {
    return { code: "timeout", message: "Database statement timeout", retryable: true };
  }
  const message = scrub(error instanceof Error ? error.message : String(error), config);
  const code = errorCode(error);
  if (/ER_BAD_DB_ERROR|\b1049\b|unknown database/i.test(`${code} ${message}`)) {
    return {
      code: "invalid_configuration",
      field: "database",
      message: `Database "${config.database}" does not exist or is not accessible`,
    };
  }
  if (/ER_ACCESS_DENIED_ERROR|ER_NOT_SUPPORTED_AUTH_MODE|AUTH_SWITCH_PLUGIN_ERROR|\b1045\b|access denied|authentication (?:failed|plugin)/i.test(`${code} ${message}`)) {
    return { code: "authentication_failed", message: "Database authentication failed" };
  }
  if (/max_execution_time|max_statement_time|query execution was interrupted|timed? out|timeout/i.test(message)) {
    return { code: "timeout", message: "Database statement timeout", retryable: true };
  }
  return {
    code: fallback,
    message: fallback === "connection_failed" ? "Could not connect to the database" : message,
    retryable: fallback === "connection_failed",
  };
}

export function boundMysqlCap(cap: number): number {
  const finite = Number.isFinite(cap) ? Math.floor(cap) : ROW_CAP;
  return Math.max(1, Math.min(ROW_CAP, finite));
}

function serializeForSize(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) ?? "null";
}

/**
 * Blank MySQL strings, comments, and backtick identifiers before policy scans.
 * Executable version comments are rejected instead of blanked: MySQL runs their
 * contents, so treating them as comments would let an unsafe call hide inside.
 */
export function blankMysqlLiteralsAndComments(
  sql: string,
  options: { backslashEscapes?: boolean } = {},
): {
  blanked: string;
  ok: boolean;
  executableComment: boolean;
  quotedCalls: string[];
} {
  const out = sql.split("");
  const quotedCalls: string[] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (sql.slice(i, i + 3) === "/*!") {
      return { blanked: out.join(""), ok: false, executableComment: true, quotedCalls };
    }
    if ((two === "--" && (!sql[i + 2] || /\s/.test(sql[i + 2]!))) || sql[i] === "#") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "--") {
      // MySQL requires whitespace after -- for a comment. Prevent the shared
      // PostgreSQL-aware scanner from reinterpreting subtraction as a comment.
      out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { blanked: out.join(""), ok: false, executableComment: false, quotedCalls };
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      let j = i + 1;
      let terminated = false;
      while (j < sql.length) {
        if (options.backslashEscapes !== false && sql[j] === "\\" && j + 1 < sql.length) {
          j += 2;
          continue;
        }
        if (sql[j] === quote && sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          j++;
          terminated = true;
          break;
        }
        j++;
      }
      if (!terminated) return { blanked: out.join(""), ok: false, executableComment: false, quotedCalls };
      if (quote === "`") {
        const name = sql.slice(i + 1, j - 1).replaceAll("``", "`");
        if (/^\s*\(/.test(sql.slice(j))) quotedCalls.push(name);
      }
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return { blanked: out.join(""), ok: true, executableComment: false, quotedCalls };
}

export function guardMysqlStatement(
  rawSql: string,
  options: { backslashEscapes?: boolean } = {},
):
  | { ok: true; sql: string; isExplain: boolean }
  | { ok: false; error: DatabaseError } {
  const trimmed = rawSql.trim();
  const inspected = blankMysqlLiteralsAndComments(trimmed, options);
  if (!inspected.ok) {
    return {
      ok: false,
      error: {
        code: "query_rejected",
        message: inspected.executableComment
          ? "Executable MySQL comments are not permitted"
          : "Statement contains an unterminated string, identifier, or comment",
      },
    };
  }

  // The shared policy remains the authority for prefixes, multiple statements,
  // EXPLAIN ANALYZE, and write keywords. Supplying same-length blanked text also
  // teaches it MySQL's # comments, backslash escapes, and backtick identifiers.
  const guarded = guardReadOnly(inspected.blanked);
  if (!guarded.ok) return { ok: false, error: { code: "query_rejected", message: guarded.reason } };

  const scan = inspected.blanked;
  const unsafeClause = /\binto\s+(?:out|dump)file\b/i.exec(scan);
  if (unsafeClause) {
    return { ok: false, error: { code: "query_rejected", message: "MySQL file output is not permitted" } };
  }
  const unsafeFunctions = ["load_file", "get_lock", "release_lock", "is_free_lock", "is_used_lock", "sleep", "benchmark"];
  for (const name of unsafeFunctions) {
    if (new RegExp(`\\b${name}\\s*\\(`, "i").test(scan) || inspected.quotedCalls.some((called) => called.toLowerCase() === name)) {
      return { ok: false, error: { code: "query_rejected", message: `MySQL function ${name} is not permitted` } };
    }
  }
  if (/@\s*(?:[A-Za-z0-9_$.-￿]+\s*)?:=/.test(scan) || /\binto\s+@/i.test(scan)) {
    return { ok: false, error: { code: "query_rejected", message: "MySQL user-variable assignment is not permitted" } };
  }

  const withoutTrailing = inspected.blanked.replace(/;\s*$/, "");
  return {
    ok: true,
    sql: trimmed.slice(0, withoutTrailing.length).trimEnd(),
    isExplain: guarded.isExplain,
  };
}

export async function queryMysqlWithTimeout<T>(
  sql: MysqlSqlClient,
  statement: string,
  values?: unknown[],
  timeoutMs = sql.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
): Promise<T> {
  const query = Promise.resolve(sql.query<T>(statement, values)).then(([rows]) => rows);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new MysqlClientTimeoutError());
      try { sql.destroy(); } catch { /* cleanup below still attempts end */ }
    }, timeoutMs);
  });
  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const queryWithTimeout = queryMysqlWithTimeout;

function requireSupportedVersion(raw: unknown): MysqlServerVersion {
  const version = parseMysqlServerVersion(raw);
  if (!version) {
    throw new MysqlAdapterError({
      code: "unsupported_version",
      message: "The database server returned an unrecognized MySQL/MariaDB version",
    });
  }
  return version;
}

function legacyGrantError(version: MysqlServerVersion): MysqlAdapterError {
  return new MysqlAdapterError({
    code: "unsupported_capability",
    message: `${version.product} ${version.version} cannot provide a read-only transaction and its effective privileges could not be verified as SELECT-only`,
  });
}

/** SHOW GRANTS rows are sensitive: validate in memory and never echo them. */
export function verifyMysqlSelectOnlyGrants(rows: Record<string, unknown>[]): boolean {
  if (!rows.length) return false;
  for (const row of rows) {
    const values = Object.values(row);
    if (values.length !== 1 || typeof values[0] !== "string") return false;
    const grant = values[0].trim();
    if (!grant || /[\0\r\n]/.test(grant) || /\bWITH\s+GRANT\s+OPTION\b/i.test(grant)) return false;
    const parsed = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/i.exec(grant);
    if (!parsed) return false;
    const privileges = parsed[1]!.split(",").map((value) => value.trim().toUpperCase());
    if (!privileges.length || privileges.some((privilege) => privilege !== "SELECT" && privilege !== "USAGE")) {
      return false;
    }
    const scope = parsed[2]!.trim();
    const identifier = "(?:\\*|`(?:``|[^`])+`)";
    if (!new RegExp(`^${identifier}\\.${identifier}$`).test(scope)) return false;
    const quotedPrincipalPart = "(?:'(?:''|[^'])*'|`(?:``|[^`])*`)";
    const principal = new RegExp(`^${quotedPrincipalPart}@${quotedPrincipalPart}`).exec(parsed[3]!);
    if (!principal) return false;
    let options = parsed[3]!.slice(principal[0].length);
    const consume = (pattern: RegExp): boolean => {
      const match = pattern.exec(options);
      if (!match) return false;
      options = options.slice(match[0].length);
      return true;
    };
    consume(/^\s+IDENTIFIED\s+BY\s+PASSWORD\s+'(?:''|[^'])*'/i);
    if (/^\s+REQUIRE\b/i.test(options)) {
      if (!consume(/^\s+REQUIRE\s+(?:NONE|SSL|X509)\b/i)
        && !consume(/^\s+REQUIRE\s+(?:CIPHER|ISSUER|SUBJECT)\s+'(?:''|[^'])*'(?:\s+AND\s+(?:CIPHER|ISSUER|SUBJECT)\s+'(?:''|[^'])*')*/i)) {
        return false;
      }
    }
    if (/^\s+WITH\b/i.test(options)
      && !consume(/^\s+WITH(?:\s+(?:MAX_QUERIES_PER_HOUR|MAX_UPDATES_PER_HOUR|MAX_CONNECTIONS_PER_HOUR|MAX_USER_CONNECTIONS)\s+\d+)+/i)) {
      return false;
    }
    if (options.trim()) return false;
  }
  return true;
}

async function verifyLegacyProtection(sql: MysqlSqlClient, version: MysqlServerVersion): Promise<void> {
  let grants: Record<string, unknown>[];
  try {
    grants = await queryWithTimeout(sql, "SHOW GRANTS FOR CURRENT_USER()");
  } catch {
    throw legacyGrantError(version);
  }
  if (!verifyMysqlSelectOnlyGrants(grants)) throw legacyGrantError(version);
}

async function establishReadOnlyProtection(
  sql: MysqlSqlClient,
  version: MysqlServerVersion,
  onStarted: () => void,
): Promise<void> {
  if (version.product === "MySQL" && version.major <= 4) {
    await verifyLegacyProtection(sql, version);
    return;
  }
  try {
    await queryWithTimeout(sql, "START TRANSACTION READ ONLY");
  } catch (error) {
    if (error instanceof MysqlClientTimeoutError) throw error;
    if (version.product === "MariaDB" && !versionAtLeast(version, 10, 0, 0)) {
      await verifyLegacyProtection(sql, version);
      return;
    }
    throw new MysqlAdapterError({
      code: "unsupported_capability",
      message: `${version.product} ${version.version} does not provide a usable server-enforced READ ONLY transaction`,
    });
  }
  onStarted();

  // MySQL and MariaDB chose different names and units. Older versions still
  // retain the mandatory cancellable client deadline applied by queryWithTimeout.
  if (version.product === "MySQL" && versionAtLeast(version, 5, 7, 4)) {
    await queryWithTimeout(sql, `SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`);
  } else if (version.product === "MariaDB" && versionAtLeast(version, 10, 1, 1)) {
    await queryWithTimeout(sql, `SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_MS / 1000}`);
  }
}

function rowValue(row: Record<string, unknown>, name: string): unknown {
  const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : row[found];
}

async function selectConfiguredDatabase(sql: MysqlSqlClient, expectedDatabase: string): Promise<void> {
  const rows = await queryWithTimeout<Record<string, unknown>[]>(sql, "SHOW DATABASES");
  const exists = rows.some((row) => String(Object.values(row)[0] ?? "") === expectedDatabase);
  if (!exists) {
    throw new MysqlAdapterError({
      code: "invalid_configuration",
      field: "database",
      message: `Database "${expectedDatabase}" does not exist or is not accessible`,
    });
  }
  await queryWithTimeout(sql, `USE ${quoteIdentifier(expectedDatabase)}`);
}

async function readServerIdentity(sql: MysqlSqlClient, expectedDatabase: string): Promise<{
  version: MysqlServerVersion;
  databaseName: string;
  authenticatedAs: string;
}> {
  await selectConfiguredDatabase(sql, expectedDatabase);
  const rows = await queryWithTimeout<Record<string, unknown>[]>(sql, `
    SELECT VERSION() AS serverVersion,
           DATABASE() AS databaseName,
           CURRENT_USER() AS authenticatedAs
  `);
  const row = rows[0] ?? {};
  const databaseName = String(row.databaseName ?? "");
  if (!databaseName || databaseName !== expectedDatabase) {
    throw new MysqlAdapterError({
      code: "invalid_configuration",
      field: "database",
      message: `Database "${expectedDatabase}" was not selected by the server`,
    });
  }
  return {
    version: requireSupportedVersion(row.serverVersion),
    databaseName,
    authenticatedAs: String(row.authenticatedAs ?? ""),
  };
}

async function cleanup(sql: MysqlSqlClient | undefined, inTransaction: boolean): Promise<void> {
  if (!sql) return;
  if (inTransaction) {
    try { await queryWithTimeout(sql, "ROLLBACK"); } catch { /* closing is the final cleanup boundary */ }
  }
  try { await sql.end(); } catch { /* no credential-bearing cleanup error escapes */ }
}

function makeTestConnection(factory: MysqlClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
  ): Promise<DatabaseResult<{ serverVersion?: string; serverProduct?: "MySQL" | "MariaDB" }>> => {
    let sql: MysqlSqlClient | undefined;
    let inTransaction = false;
    try {
      sql = await factory(config, target);
      const identity = await readServerIdentity(sql, config.database);
      await establishReadOnlyProtection(sql, identity.version, () => { inTransaction = true; });
      return {
        ok: true,
        value: { serverVersion: identity.version.version, serverProduct: identity.version.product },
      };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "connection_failed") };
    } finally {
      await cleanup(sql, inTransaction);
    }
  };
}

type IndexRow = {
  schemaName: unknown;
  tableName: unknown;
  indexName: unknown;
  nonUnique: unknown;
  seq: unknown;
  columnName: unknown;
  subPart: unknown;
  collation: unknown;
};

const quoteIdentifier = (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``;

function groupIndexes(rows: IndexRow[]): RawCatalog["indexes"] {
  const grouped = new Map<string, { schemaName: string; tableName: string; indexName: string; unique: boolean; columns: string[] }>();
  for (const row of rows) {
    const schemaName = String(row.schemaName ?? "");
    const tableName = String(row.tableName ?? "");
    const indexName = String(row.indexName ?? "");
    const key = `${schemaName}\0${tableName}\0${indexName}`;
    const entry = grouped.get(key) ?? {
      schemaName,
      tableName,
      indexName,
      unique: Number(row.nonUnique) === 0,
      columns: [],
    };
    const column = quoteIdentifier(String(row.columnName ?? "?"));
    const prefix = row.subPart == null ? "" : `(${Number(row.subPart)})`;
    const direction = String(row.collation ?? "").toUpperCase() === "D" ? " DESC" : "";
    entry.columns.push(`${column}${prefix}${direction}`);
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((entry) => ({
    schemaName: entry.schemaName,
    tableName: entry.tableName,
    definition: `${entry.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(entry.indexName)} (${entry.columns.join(", ")})`,
  }));
}

function parseQuotedIdentifierList(value: string): string[] | null {
  const identifiers: string[] = [];
  let rest = value.trim();
  while (rest) {
    const match = /^`((?:``|[^`])+)`\s*(?:,\s*|$)/.exec(rest);
    if (!match) return null;
    identifiers.push(match[1]!.replaceAll("``", "`"));
    rest = rest.slice(match[0].length);
  }
  return identifiers.length ? identifiers : null;
}

export function parseLegacyMysqlForeignKeys(
  createSql: unknown,
  schemaName: string,
  tableName: string,
): RawCatalog["foreignKeys"] | null {
  if (typeof createSql !== "string") return null;
  const foreignKeyCount = [...createSql.matchAll(/\bFOREIGN\s+KEY\b/gi)].length;
  if (!foreignKeyCount) return [];
  const clause = /(?:CONSTRAINT\s+`(?:``|[^`])+`\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:(`(?:``|[^`])+`)\s*\.\s*)?(`(?:``|[^`])+`)\s*\(([^)]+)\)/gi;
  const foreignKeys: RawCatalog["foreignKeys"] = [];
  let parsedCount = 0;
  for (const match of createSql.matchAll(clause)) {
    parsedCount++;
    const columns = parseQuotedIdentifierList(match[1]!);
    const refColumns = parseQuotedIdentifierList(match[4]!);
    if (!columns || !refColumns || columns.length !== refColumns.length) return null;
    const unquote = (value: string) => value.slice(1, -1).replaceAll("``", "`");
    const refSchema = match[2] ? unquote(match[2]) : schemaName;
    const refTable = unquote(match[3]!);
    for (let index = 0; index < columns.length; index++) {
      foreignKeys.push({
        schemaName,
        tableName,
        columnName: columns[index]!,
        refSchema,
        refTable,
        refColumn: refColumns[index]!,
      });
    }
  }
  return parsedCount === foreignKeyCount ? foreignKeys : null;
}

async function fetchLegacyCatalog(
  sql: MysqlSqlClient,
  config: DatabaseConnectionConfig,
  onStep?: (step: CatalogStep) => void,
): Promise<RawCatalog> {
  const schemaName = config.database;
  if (MYSQL_SYSTEM_SCHEMAS.has(schemaName.toLowerCase())) {
    for (const step of ["tables", "columns", "primaryKeys", "foreignKeys", "indexes"] as const) {
      onStep?.({ step, count: 0 });
    }
    return { tables: [], columns: [], primaryKeys: [], foreignKeys: [], indexes: [] };
  }
  const statusRows = await queryWithTimeout<Record<string, unknown>[]>(
    sql,
    `SHOW TABLE STATUS FROM ${quoteIdentifier(schemaName)}`,
  );
  const tables = statusRows.map((row) => ({
    schemaName,
    name: String(rowValue(row, "Name") ?? ""),
    comment: String(rowValue(row, "Comment") ?? "") || null,
    rowEstimate: Number(rowValue(row, "Rows") ?? 0),
  }));
  if (tables.some((table) => !table.name)) {
    throw new MysqlAdapterError({
      code: "unsupported_capability",
      message: "The legacy MySQL server returned table metadata that could not be parsed safely",
    });
  }
  onStep?.({ step: "tables", count: tables.length });

  const columns: RawCatalog["columns"] = [];
  const primaryKeys: RawCatalog["primaryKeys"] = [];
  for (const table of tables) {
    const rows = await queryWithTimeout<Record<string, unknown>[]>(
      sql,
      `SHOW FULL COLUMNS FROM ${quoteIdentifier(table.name)} FROM ${quoteIdentifier(schemaName)}`,
    );
    rows.forEach((row, index) => {
      const name = String(rowValue(row, "Field") ?? "");
      const dataType = String(rowValue(row, "Type") ?? "");
      if (!name || !dataType) {
        throw new MysqlAdapterError({
          code: "unsupported_capability",
          message: "The legacy MySQL server returned column metadata that could not be parsed safely",
        });
      }
      columns.push({
        schemaName,
        tableName: table.name,
        seq: index + 1,
        name,
        dataType,
        nullable: String(rowValue(row, "Null") ?? "").toUpperCase() === "YES",
        comment: String(rowValue(row, "Comment") ?? "") || null,
      });
      if (String(rowValue(row, "Key") ?? "").toUpperCase() === "PRI") {
        primaryKeys.push({ schemaName, tableName: table.name, columnName: name });
      }
    });
  }
  onStep?.({ step: "columns", count: columns.length });
  onStep?.({ step: "primaryKeys", count: primaryKeys.length });

  const foreignKeys: RawCatalog["foreignKeys"] = [];
  for (const table of tables) {
    const rows = await queryWithTimeout<Record<string, unknown>[]>(
      sql,
      `SHOW CREATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(table.name)}`,
    );
    const row = rows[0];
    const createSql = row && (rowValue(row, "Create Table") ?? rowValue(row, "Create View"));
    const parsed = parseLegacyMysqlForeignKeys(createSql, schemaName, table.name);
    if (!parsed) {
      throw new MysqlAdapterError({
        code: "unsupported_capability",
        message: "The legacy MySQL server returned foreign-key metadata that could not be parsed safely",
      });
    }
    foreignKeys.push(...parsed);
  }
  onStep?.({ step: "foreignKeys", count: foreignKeys.length });

  const indexRows: IndexRow[] = [];
  for (const table of tables) {
    const rows = await queryWithTimeout<Record<string, unknown>[]>(
      sql,
      `SHOW INDEX FROM ${quoteIdentifier(table.name)} FROM ${quoteIdentifier(schemaName)}`,
    );
    for (const row of rows) {
      const indexName = String(rowValue(row, "Key_name") ?? "");
      const columnName = String(rowValue(row, "Column_name") ?? "");
      if (!indexName || !columnName) {
        throw new MysqlAdapterError({
          code: "unsupported_capability",
          message: "The legacy MySQL server returned index metadata that could not be parsed safely",
        });
      }
      indexRows.push({
        schemaName,
        tableName: table.name,
        indexName,
        nonUnique: rowValue(row, "Non_unique"),
        seq: rowValue(row, "Seq_in_index"),
        columnName,
        subPart: rowValue(row, "Sub_part"),
        collation: rowValue(row, "Collation"),
      });
    }
  }
  indexRows.sort((left, right) =>
    String(left.tableName).localeCompare(String(right.tableName))
    || String(left.indexName).localeCompare(String(right.indexName))
    || Number(left.seq) - Number(right.seq));
  const indexes = groupIndexes(indexRows);
  onStep?.({ step: "indexes", count: indexes.length });
  return { tables, columns, primaryKeys, foreignKeys, indexes };
}

function makeFetchCatalog(factory: MysqlClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    onStep?: (step: CatalogStep) => void,
  ): Promise<DatabaseResult<RawCatalog>> => {
    let sql: MysqlSqlClient | undefined;
    let inTransaction = false;
    try {
      sql = await factory(config, target);
      const { version } = await readServerIdentity(sql, config.database);
      await establishReadOnlyProtection(sql, version, () => { inTransaction = true; });

      if (version.product === "MySQL" && version.major <= 4) {
        return { ok: true, value: await fetchLegacyCatalog(sql, config, onStep) };
      }

      const tables = await queryWithTimeout<any[]>(sql, `
        SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS name,
               NULLIF(TABLE_COMMENT, '') AS comment, COALESCE(TABLE_ROWS, 0) AS rowEstimate
        FROM information_schema.tables
        WHERE TABLE_SCHEMA = ?
          AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
          AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `, [config.database]);
      onStep?.({ step: "tables", count: tables.length });

      const columns = await queryWithTimeout<any[]>(sql, `
        SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName,
               ORDINAL_POSITION AS seq, COLUMN_NAME AS name, COLUMN_TYPE AS dataType,
               IS_NULLABLE AS isNullable, NULLIF(COLUMN_COMMENT, '') AS comment
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = ?
          AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `, [config.database]);
      onStep?.({ step: "columns", count: columns.length });

      const primaryKeys = await queryWithTimeout<any[]>(sql, `
        SELECT k.TABLE_SCHEMA AS schemaName, k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName
        FROM information_schema.table_constraints t
        JOIN information_schema.key_column_usage k
          ON k.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA
         AND k.TABLE_NAME = t.TABLE_NAME
         AND k.CONSTRAINT_NAME = t.CONSTRAINT_NAME
        WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' AND t.TABLE_SCHEMA = ?
          AND t.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
        ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.ORDINAL_POSITION
      `, [config.database]);
      onStep?.({ step: "primaryKeys", count: primaryKeys.length });

      const foreignKeys = await queryWithTimeout<any[]>(sql, `
        SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
               REFERENCED_TABLE_SCHEMA AS refSchema, REFERENCED_TABLE_NAME AS refTable,
               REFERENCED_COLUMN_NAME AS refColumn
        FROM information_schema.key_column_usage
        WHERE TABLE_SCHEMA = ?
          AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
          AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
      `, [config.database]);
      onStep?.({ step: "foreignKeys", count: foreignKeys.length });

      const indexRows = await queryWithTimeout<IndexRow[]>(sql, `
        SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
               NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName,
               SUB_PART AS subPart, COLLATION AS collation
        FROM information_schema.statistics
        WHERE TABLE_SCHEMA = ?
          AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
        ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
      `, [config.database]);
      const indexes = groupIndexes(indexRows);
      onStep?.({ step: "indexes", count: indexes.length });

      return {
        ok: true,
        value: {
          tables: tables.map((row) => ({
            schemaName: String(row.schemaName),
            name: String(row.name),
            comment: row.comment == null ? null : String(row.comment),
            rowEstimate: Number(row.rowEstimate ?? 0),
          })),
          columns: columns.map((row) => ({
            schemaName: String(row.schemaName),
            tableName: String(row.tableName),
            seq: Number(row.seq),
            name: String(row.name),
            dataType: String(row.dataType),
            nullable: String(row.isNullable).toUpperCase() === "YES",
            comment: row.comment == null ? null : String(row.comment),
          })),
          primaryKeys: primaryKeys.map((row) => ({
            schemaName: String(row.schemaName),
            tableName: String(row.tableName),
            columnName: String(row.columnName),
          })),
          foreignKeys: foreignKeys.map((row) => ({
            schemaName: String(row.schemaName),
            tableName: String(row.tableName),
            columnName: String(row.columnName),
            refSchema: String(row.refSchema),
            refTable: String(row.refTable),
            refColumn: String(row.refColumn),
          })),
          indexes,
        },
      };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "connection_failed") };
    } finally {
      await cleanup(sql, inTransaction);
    }
  };
}

function makeExecuteReadOnly(factory: MysqlClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    rawSql: string,
    cap: number = ROW_CAP,
  ): Promise<QueryOutcome> => {
    const guarded = guardMysqlStatement(rawSql);
    if (!guarded.ok) return { ok: false, error: guarded.error };
    const bounded = boundMysqlCap(cap);

    let sql: MysqlSqlClient | undefined;
    let inTransaction = false;
    try {
      sql = await factory(config, target);
      const { version } = await readServerIdentity(sql, config.database);
      const modeRows = await queryWithTimeout<Record<string, unknown>[]>(
        sql,
        "SELECT @@SESSION.sql_mode AS sqlMode",
      );
      const modes = String(modeRows[0]?.sqlMode ?? "")
        .split(",")
        .map((mode) => mode.trim().toUpperCase());
      const serverGuarded = guardMysqlStatement(rawSql, {
        backslashEscapes: !modes.includes("NO_BACKSLASH_ESCAPES"),
      });
      if (!serverGuarded.ok) return { ok: false, error: serverGuarded.error };
      const statement = serverGuarded.isExplain
        ? serverGuarded.sql
        : `SELECT * FROM (\n${serverGuarded.sql}\n) AS \`_capped\`\nLIMIT ${bounded + 1}`;
      await establishReadOnlyProtection(sql, version, () => { inTransaction = true; });
      const rows = await queryWithTimeout<Record<string, unknown>[]>(sql, statement);
      const rowCapped = !serverGuarded.isExplain && rows.length > bounded;
      const rowLimited = rowCapped ? rows.slice(0, bounded) : rows;
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
      return {
        ok: true,
        columns: rowLimited.length ? Object.keys(rowLimited[0]!) : [],
        rows: shown,
        truncated: rowCapped || byteCapped,
        truncatedReason: byteCapped ? "bytes" : rowCapped ? "rows" : null,
      };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "query_failed") };
    } finally {
      await cleanup(sql, inTransaction);
    }
  };
}

function validate(config: DatabaseConnectionConfig): DatabaseError | null {
  if (config.engine !== "mysql") {
    return { code: "unsupported_engine", message: "MySQL adapter received another engine", field: "engine" };
  }
  if (!config.host.trim() || config.host.length > 253 || /[\0\r\n]/.test(config.host)) {
    return { code: "invalid_configuration", message: config.host.trim() ? "Host is invalid" : "Host is required", field: "host" };
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    return { code: "invalid_configuration", message: "Port must be between 1 and 65535", field: "port" };
  }
  if (!config.database.trim() || config.database.length > 128 || /[\0\r\n]/.test(config.database)) {
    return { code: "invalid_configuration", message: config.database.trim() ? "Database name is invalid" : "Database name is required", field: "database" };
  }
  if (!config.username.trim() || config.username.length > 128 || /[\0\r\n]/.test(config.username)) {
    return { code: "invalid_configuration", message: config.username.trim() ? "Username is invalid" : "Username is required", field: "username" };
  }
  if (!config.password) return { code: "invalid_configuration", message: "Password is required", field: "password" };
  if (config.password.length > 4096 || /[\0\r\n]/.test(config.password)) {
    return { code: "invalid_configuration", message: "Password is invalid", field: "password" };
  }
  if (!["disable", "require", "verify-full"].includes(config.ssl.mode)) {
    return { code: "invalid_configuration", message: "Unsupported MySQL SSL mode", field: "ssl.mode" };
  }
  if (config.ssl.ca && (config.ssl.ca.length > 131_072 || config.ssl.ca.includes("\0"))) {
    return { code: "invalid_configuration", message: "Custom CA is invalid or too large", field: "ssl.ca" };
  }
  if (config.ssl.serverName && (config.ssl.serverName.length > 253 || /[\s/\\\0]/.test(config.ssl.serverName))) {
    return { code: "invalid_configuration", message: "TLS server name is invalid", field: "ssl.serverName" };
  }
  if (config.ssl.mode === "verify-full" && isIP(config.ssl.serverName || config.host)) {
    return {
      code: "invalid_configuration",
      message: "MySQL verify-full requires a DNS TLS server name when the connection host is an IP address",
      field: "ssl.serverName",
    };
  }
  return null;
}

export function createMysqlAdapter(factory: MysqlClientFactory = mysql2Client): DatabaseAdapter {
  return {
    engine: "mysql",
    defaultPort: 3306,
    capabilities: {
      schemas: true,
      explain: true,
      sslModes: ["disable", "require", "verify-full"],
      readOnlyTransactions: true,
      statementTimeout: true,
    },
    validate,
    quoteIdentifier,
    testConnection: makeTestConnection(factory),
    fetchCatalog: makeFetchCatalog(factory),
    executeReadOnly: makeExecuteReadOnly(factory),
  };
}

export const mysqlAdapter = createMysqlAdapter();
