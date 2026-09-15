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
import { DATABASE_BYTE_CAP, DATABASE_ROW_CAP } from "./query-policy";

const TIMEOUT_SECONDS = 10;
const ROW_CAP = DATABASE_ROW_CAP;
const BYTE_CAP = DATABASE_BYTE_CAP;
export const SYBASE_DEFAULT_TDS_VERSION = "5.0";
export const SYBASE_DEFAULT_CLIENT_CHARSET = "ISO-8859-1";

export type SybaseResult = Record<string, unknown>[] & {
  columns?: Array<{ name?: string }>;
};

export type SybaseCursor = {
  fetch(): PromiseLike<SybaseResult>;
  close(): PromiseLike<unknown>;
};

export type SybaseClient = {
  query(statement: string): PromiseLike<SybaseResult>;
  openCursor(statement: string, fetchSize: number): PromiseLike<SybaseCursor>;
  close(): PromiseLike<unknown>;
};

export type SybaseClientFactory = (
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
) => SybaseClient | PromiseLike<SybaseClient>;

class SybaseAdapterError extends Error {
  constructor(readonly databaseError: DatabaseError) {
    super(databaseError.message);
  }
}

/** ODBC brace quoting is the only form that protects `;`, `=`, and `}`. */
export function escapeOdbcValue(value: unknown): string {
  return `{${String(value).replaceAll("}", "}}")}}`;
}

export function sybaseConnectionString(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
): string {
  const tdsVersion = config.sybase?.tdsVersion?.trim() || SYBASE_DEFAULT_TDS_VERSION;
  const clientCharset = config.sybase?.clientCharset?.trim() || SYBASE_DEFAULT_CLIENT_CHARSET;
  const attributes: Array<[string, unknown]> = [
    ["Driver", "FreeTDS"],
    // The configured name is display-only here. FreeTDS must dial the literal
    // address that already passed DatabaseNetworkPolicy.
    ["Server", target.address],
    ["Port", config.port],
    ["Database", config.database],
    ["UID", config.username],
    ["PWD", config.password],
    ["TDS_Version", tdsVersion],
    ["ClientCharset", clientCharset],
    ["Encryption", "off"],
    ["APP", "Pixelspace"],
  ];
  return attributes.map(([key, value]) => `${key}=${escapeOdbcValue(value)}`).join(";");
}

export const createSybaseOdbcClient: SybaseClientFactory = async (config, target) => {
  // Lazy loading keeps an unavailable native driver from taking down API
  // startup on hosts that have no configured SAP ASE connection.
  const { default: odbc } = await import("odbc");
  const connection = await odbc.connect({
    connectionString: sybaseConnectionString(config, target),
    connectionTimeout: TIMEOUT_SECONDS,
    loginTimeout: TIMEOUT_SECONDS,
  });
  return {
    query: (statement) => connection.query<Record<string, unknown>, { timeout: number }>(
      statement,
      [],
      { timeout: TIMEOUT_SECONDS },
    ),
    openCursor: (statement, _fetchSize) => connection.query<Record<string, unknown>, {
      cursor: true;
      fetchSize: number;
      timeout: number;
    // FreeTDS's ASE ODBC driver cannot implement SQLSetPos for rowsets larger
    // than one. Fetch single rows, and let the adapter stop at cap + 1.
    }>(statement, [], { cursor: true, fetchSize: 1, timeout: TIMEOUT_SECONDS }),
    close: () => connection.close(),
  };
};

function errorFacts(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as {
    code?: unknown;
    state?: unknown;
    odbcErrors?: Array<{ code?: unknown; state?: unknown; message?: unknown }>;
  };
  return [
    value.code,
    value.state,
    ...(value.odbcErrors ?? []).flatMap((item) => [item.code, item.state, item.message]),
    error instanceof Error ? error.message : "",
  ].filter((part) => part != null).join(" ");
}

function databaseError(
  error: unknown,
  config: DatabaseConnectionConfig,
  fallback: DatabaseError["code"],
): DatabaseError {
  if (error instanceof SybaseAdapterError) return error.databaseError;
  // Facts are inspected only for classification. No ODBC driver detail is
  // ever returned, even if a driver includes the DSN-less string in it.
  const facts = scrubDatabaseMessage(errorFacts(error), config, "sybase://***");
  if (/\b(?:HYT00|HYT01|S1T00)\b|timed? out|timeout/i.test(facts)) {
    return { code: "timeout", message: "Database statement timeout", retryable: true };
  }
  if (/\b(?:911|916)\b|unknown database|database .*not (?:found|available|accessible)/i.test(facts)) {
    return {
      code: "invalid_configuration",
      field: "database",
      message: `Database "${config.database}" does not exist or is not accessible`,
    };
  }
  if (/\b28000\b|login failed|authentication|password/i.test(facts)) {
    return { code: "authentication_failed", message: "Database authentication failed" };
  }
  if (/permission denied|not authorized|insufficient privilege/i.test(facts)) {
    return { code: "unsupported_capability", message: "SAP ASE login lacks required read-only catalog permissions" };
  }
  if (/\b(?:08001|08003|08004|08006|08S01)\b|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(facts)) {
    return { code: "connection_failed", message: "Could not connect to the database", retryable: true };
  }
  return {
    code: fallback,
    message: fallback === "connection_failed" ? "Could not connect to the database" : "Database query failed",
    retryable: fallback === "connection_failed",
  };
}

function rowValue(row: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : row[key];
}

function numberValue(row: Record<string, unknown>, name: string): number {
  const value = Number(rowValue(row, name) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function truthy(row: Record<string, unknown>, name: string): boolean {
  return numberValue(row, name) !== 0;
}

export type SybaseServerVersion = { version: string; raw: string };

export function parseSybaseServerVersion(value: unknown): SybaseServerVersion | null {
  const raw = String(value ?? "").trim();
  if (!/Adaptive Server Enterprise/i.test(raw) || /(?:OpenServer|Open Server|Backup Server)/i.test(raw)) return null;
  const version = /Adaptive Server Enterprise\s*\/\s*(\d+(?:\.\d+){1,3})/i.exec(raw)
    ?? /Adaptive Server Enterprise\D+(\d+(?:\.\d+){1,3})/i.exec(raw);
  if (!version) return null;
  const servicePack = /\bSP\s*([0-9]+)\b/i.exec(raw);
  return { version: `${version[1]}${servicePack ? ` SP${servicePack[1]}` : ""}`, raw };
}

const IDENTITY_SQL = `
  SELECT db_name() AS databaseName,
         @@version AS versionText,
         user_name() AS databaseUser,
         user_id() AS databaseUserId,
         has_role('sa_role', 1) AS hasSaRole,
         has_role('sso_role', 1) AS hasSsoRole,
         has_role('oper_role', 1) AS hasOperRole
`;

const PERMISSION_SQL = `
  SELECT
    (SELECT count(*)
       FROM sysprotects p
      WHERE p.protecttype IN (0, 1)
        AND p.action IN (5, 133, 134, 193)
        AND (p.uid = user_id() OR p.uid = 0 OR p.uid =
          (SELECT u.gid FROM sysusers u WHERE u.uid = user_id()))) AS selectGrants,
    (SELECT count(*)
       FROM sysprotects p
      WHERE p.protecttype IN (0, 1)
        AND p.uid = user_id()
        AND p.action NOT IN (5, 133, 134, 148, 193, 253)) AS dangerousUserGrants,
    (SELECT count(*)
       FROM sysprotects p, sysusers u
      WHERE u.uid = user_id()
        AND u.gid >= 16384
        AND p.uid = u.gid
        AND p.protecttype IN (0, 1)
        AND p.action NOT IN (5, 133, 134, 148, 193, 253)) AS dangerousGroupGrants,
    (SELECT count(*)
       FROM sysobjects o
      WHERE o.uid = user_id()
        AND o.type IN ('U', 'V', 'P', 'TR', 'R', 'D', 'SF', 'F')) AS ownedObjects
`;

export function isReadOnlySybasePrincipal(
  identity: Record<string, unknown>,
  permissions: Record<string, unknown>,
): boolean {
  return numberValue(identity, "databaseUserId") !== 1
    && !truthy(identity, "hasSaRole")
    && !truthy(identity, "hasSsoRole")
    && !truthy(identity, "hasOperRole")
    && numberValue(permissions, "selectGrants") > 0
    && numberValue(permissions, "dangerousUserGrants") === 0
    && numberValue(permissions, "dangerousGroupGrants") === 0
    && numberValue(permissions, "ownedObjects") === 0
    && numberValue(permissions, "assignedRoles") === 0;
}

async function readIdentityAndVerify(
  client: SybaseClient,
  expectedDatabase: string,
): Promise<SybaseServerVersion> {
  const identity = (await client.query(IDENTITY_SQL))[0] ?? {};
  const selected = String(rowValue(identity, "databaseName") ?? "");
  if (!selected || selected.localeCompare(expectedDatabase, undefined, { sensitivity: "accent" }) !== 0) {
    throw new SybaseAdapterError({
      code: "invalid_configuration",
      field: "database",
      message: `Database "${expectedDatabase}" was not selected by the server`,
    });
  }
  const version = parseSybaseServerVersion(rowValue(identity, "versionText"));
  if (!version) {
    throw new SybaseAdapterError({
      code: "unsupported_version",
      message: "The endpoint is not SAP Adaptive Server Enterprise",
    });
  }
  const permissions = (await client.query(PERMISSION_SQL))[0] ?? {};
  // sysloginroles.suid is intentionally inaccessible to unprivileged users.
  // ASE exposes their *assigned*, including currently inactive, roles through
  // sp_displayroles. Fail closed when this procedure cannot be inspected.
  const assignedRoles = await client.query("sp_displayroles");
  if (!isReadOnlySybasePrincipal(identity, { ...permissions, assignedRoles: assignedRoles.length })) {
    throw new SybaseAdapterError({
      code: "unsupported_capability",
      message: "SAP ASE connections require a server-side read-only login",
    });
  }
  return version;
}

async function cleanup(client: SybaseClient | undefined): Promise<void> {
  if (!client) return;
  try { await client.close(); } catch { /* cleanup errors never expose ODBC details */ }
}

function makeTestConnection(factory: SybaseClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
  ): Promise<DatabaseResult<{ serverVersion?: string; serverProduct?: "SAP ASE" }>> => {
    let client: SybaseClient | undefined;
    try {
      client = await factory(config, target);
      const identity = await readIdentityAndVerify(client, config.database);
      return { ok: true, value: { serverProduct: "SAP ASE", serverVersion: identity.version } };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "connection_failed") };
    } finally {
      await cleanup(client);
    }
  };
}

const TABLES_SQL = `
  SELECT user_name(o.uid) AS schemaName,
         o.name AS name,
         convert(varchar(255), null) AS comment,
         isnull((SELECT sum(convert(numeric(20, 0), s.rowcnt))
                   FROM systabstats s
                  WHERE s.id = o.id AND s.indid IN (0, 1)), 0) AS rowEstimate
    FROM sysobjects o
   WHERE o.type IN ('U', 'V')
   ORDER BY user_name(o.uid), o.name
`;

const COLUMNS_SQL = `
  SELECT user_name(o.uid) AS schemaName,
         o.name AS tableName,
         c.colid AS seq,
         c.name AS name,
         CASE
           WHEN t.name IN ('char', 'varchar', 'binary', 'varbinary', 'unichar', 'univarchar')
             THEN t.name + '(' + rtrim(convert(varchar(10), c.length)) + ')'
           WHEN t.name IN ('decimal', 'numeric')
             THEN t.name + '(' + rtrim(convert(varchar(10), c.prec)) + ','
                  + rtrim(convert(varchar(10), c.scale)) + ')'
           ELSE t.name
         END AS dataType,
         CASE WHEN (c.status & 8) = 8 THEN 1 ELSE 0 END AS nullable,
         convert(varchar(255), null) AS comment
    FROM sysobjects o, syscolumns c, systypes t
   WHERE o.id = c.id
     AND c.usertype = t.usertype
     AND o.type IN ('U', 'V')
   ORDER BY user_name(o.uid), o.name, c.colid
`;

const indexKeyProjection = Array.from({ length: 31 }, (_, offset) => {
  const key = offset + 1;
  return `index_col(o.name, i.indid, ${key}, o.uid) AS key${key},\n`
    + `         index_colorder(o.name, i.indid, ${key}, o.uid) AS order${key}`;
}).join(",\n         ");

const PRIMARY_KEYS_SQL = `
  SELECT user_name(o.uid) AS schemaName, o.name AS tableName,
         i.name AS indexName, i.indid AS indexId, i.keycnt AS keyCount,
         ${indexKeyProjection}
    FROM sysobjects o, sysindexes i
   WHERE o.id = i.id
     AND o.type = 'U'
     AND (o.sysstat2 & 8) = 8
     AND (i.status & 2048) = 2048
   ORDER BY user_name(o.uid), o.name, i.indid
`;

const FOREIGN_KEYS_SQL = `
  SELECT user_name(fo.uid) AS schemaName,
         fo.name AS tableName,
         user_name(ro.uid) AS refSchema,
         ro.name AS refTable,
         r.constrid AS constraintId,
         r.keycnt AS keyCount,
         r.pmrydbname AS refDatabase,
         r.fokey1, r.fokey2, r.fokey3, r.fokey4,
         r.fokey5, r.fokey6, r.fokey7, r.fokey8,
         r.fokey9, r.fokey10, r.fokey11, r.fokey12,
         r.fokey13, r.fokey14, r.fokey15, r.fokey16,
         r.refkey1, r.refkey2, r.refkey3, r.refkey4,
         r.refkey5, r.refkey6, r.refkey7, r.refkey8,
         r.refkey9, r.refkey10, r.refkey11, r.refkey12,
         r.refkey13, r.refkey14, r.refkey15, r.refkey16
    FROM sysreferences r, sysconstraints sc, sysobjects fo, sysobjects ro
   WHERE sc.constrid = r.constrid
     AND (sc.status & 64) = 64
     AND fo.id = r.tableid
     AND ro.id = r.reftabid
     AND (r.pmrydbid = db_id() OR r.pmrydbid IS NULL)
   ORDER BY user_name(fo.uid), fo.name, r.constrid
`;

const INDEXES_SQL = `
  SELECT user_name(o.uid) AS schemaName, o.name AS tableName,
         i.name AS indexName, i.indid AS indexId, i.keycnt AS keyCount,
         i.status AS indexStatus,
         ${indexKeyProjection}
    FROM sysobjects o, sysindexes i
   WHERE o.id = i.id
     AND o.type = 'U'
     AND i.indid BETWEEN 1 AND 254
   ORDER BY user_name(o.uid), o.name, i.indid
`;

const compare = (...values: Array<[string, string]>): number => {
  for (const [left, right] of values) {
    const order = left.localeCompare(right);
    if (order) return order;
  }
  return 0;
};

function indexColumns(row: Record<string, unknown>): Array<{ name: string; order: string }> {
  const columns: Array<{ name: string; order: string }> = [];
  for (let key = 1; key <= 31; key++) {
    const value = rowValue(row, `key${key}`);
    if (value == null || !String(value).trim()) continue;
    columns.push({
      name: String(value).trim(),
      order: String(rowValue(row, `order${key}`) ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
    });
  }
  return columns;
}

function mapPrimaryKeys(rows: Record<string, unknown>[]): RawCatalog["primaryKeys"] {
  return rows.flatMap((row) => indexColumns(row).map((column) => ({
    schemaName: String(rowValue(row, "schemaName") ?? ""),
    tableName: String(rowValue(row, "tableName") ?? ""),
    columnName: column.name,
  })));
}

function mapForeignKeys(rows: Record<string, unknown>[], columns: Record<string, unknown>[]): RawCatalog["foreignKeys"] {
  const names = new Map<string, string>();
  for (const column of columns) {
    names.set(
      `${String(rowValue(column, "schemaName") ?? "")}\0${String(rowValue(column, "tableName") ?? "")}\0${numberValue(column, "seq")}`,
      String(rowValue(column, "name") ?? ""),
    );
  }
  return rows.flatMap((row) => {
    const schemaName = String(rowValue(row, "schemaName") ?? "");
    const tableName = String(rowValue(row, "tableName") ?? "");
    const refSchema = String(rowValue(row, "refSchema") ?? "");
    const refTable = String(rowValue(row, "refTable") ?? "");
    const count = Math.min(16, numberValue(row, "keyCount"));
    return Array.from({ length: count }, (_, offset) => {
      const position = offset + 1;
      const columnName = names.get(`${schemaName}\0${tableName}\0${numberValue(row, `fokey${position}`)}`) ?? "";
      const refColumn = names.get(`${refSchema}\0${refTable}\0${numberValue(row, `refkey${position}`)}`) ?? "";
      return { schemaName, tableName, columnName, refSchema, refTable, refColumn };
    }).filter((key) => key.columnName && key.refColumn);
  });
}

function mapIndexes(rows: Record<string, unknown>[]): RawCatalog["indexes"] {
  return rows.map((row) => {
    const keys = indexColumns(row).map((column) => `${quoteIdentifier(column.name)} ${column.order}`);
    const unique = (numberValue(row, "indexStatus") & 2) === 2 ? "UNIQUE " : "";
    return {
      schemaName: String(rowValue(row, "schemaName") ?? ""),
      tableName: String(rowValue(row, "tableName") ?? ""),
      definition: `${unique}INDEX ${quoteIdentifier(String(rowValue(row, "indexName") ?? ""))} (${keys.join(", ")})`,
    };
  });
}

function makeFetchCatalog(factory: SybaseClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    onStep?: (step: CatalogStep) => void,
  ): Promise<DatabaseResult<RawCatalog>> => {
    let client: SybaseClient | undefined;
    try {
      client = await factory(config, target);
      await readIdentityAndVerify(client, config.database);

      const tableRows = await client.query(TABLES_SQL);
      const tables = tableRows.map((row) => ({
        schemaName: String(rowValue(row, "schemaName") ?? ""),
        name: String(rowValue(row, "name") ?? ""),
        comment: rowValue(row, "comment") == null ? null : String(rowValue(row, "comment")),
        rowEstimate: numberValue(row, "rowEstimate"),
      })).sort((a, b) => compare([a.schemaName, b.schemaName], [a.name, b.name]));
      onStep?.({ step: "tables", count: tables.length });

      const columnRows = await client.query(COLUMNS_SQL);
      const columns = columnRows.map((row) => ({
        schemaName: String(rowValue(row, "schemaName") ?? ""),
        tableName: String(rowValue(row, "tableName") ?? ""),
        seq: numberValue(row, "seq"),
        name: String(rowValue(row, "name") ?? ""),
        dataType: String(rowValue(row, "dataType") ?? ""),
        nullable: truthy(row, "nullable"),
        comment: rowValue(row, "comment") == null ? null : String(rowValue(row, "comment")),
      })).sort((a, b) => compare([a.schemaName, b.schemaName], [a.tableName, b.tableName]) || a.seq - b.seq);
      onStep?.({ step: "columns", count: columns.length });

      const primaryKeys = mapPrimaryKeys(await client.query(PRIMARY_KEYS_SQL));
      onStep?.({ step: "primaryKeys", count: primaryKeys.length });

      const foreignKeys = mapForeignKeys(await client.query(FOREIGN_KEYS_SQL), columnRows);
      onStep?.({ step: "foreignKeys", count: foreignKeys.length });

      const indexes = mapIndexes(await client.query(INDEXES_SQL));
      onStep?.({ step: "indexes", count: indexes.length });
      return { ok: true, value: { tables, columns, primaryKeys, foreignKeys, indexes } };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "query_failed") };
    } finally {
      await cleanup(client);
    }
  };
}

/** Blank strings, quoted/bracketed identifiers, and nested comments. */
export function blankSybaseLiteralsAndComments(sql: string): { blanked: string; ok: boolean } {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let position = from; position < to && position < out.length; position++) {
      if (out[position] !== "\n") out[position] = " ";
    }
  };
  let index = 0;
  while (index < sql.length) {
    if (sql.slice(index, index + 2) === "--") {
      const end = sql.indexOf("\n", index + 2);
      const stop = end === -1 ? sql.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (sql.slice(index, index + 2) === "/*") {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.slice(index, index + 2) === "/*") { depth++; index += 2; }
        else if (sql.slice(index, index + 2) === "*/") { depth--; index += 2; }
        else index++;
      }
      if (depth) return { blanked: out.join(""), ok: false };
      blank(start, index);
      continue;
    }
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      const start = index++;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) index += 2;
        else if (sql[index] === quote) { index++; terminated = true; break; }
        else index++;
      }
      if (!terminated) return { blanked: out.join(""), ok: false };
      blank(start, index);
      continue;
    }
    if (quote === "[") {
      const start = index++;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === "]" && sql[index + 1] === "]") index += 2;
        else if (sql[index] === "]") { index++; terminated = true; break; }
        else index++;
      }
      if (!terminated) return { blanked: out.join(""), ok: false };
      blank(start, index);
      continue;
    }
    index++;
  }
  return { blanked: out.join(""), ok: true };
}

export function guardSybaseStatement(rawSql: string):
  | { ok: true; sql: string; isExplain: false }
  | { ok: false; error: DatabaseError } {
  const sql = rawSql.trim();
  const inspected = blankSybaseLiteralsAndComments(sql);
  const reject = (message: string) => ({
    ok: false as const,
    error: { code: "query_rejected" as const, message },
  });
  if (!inspected.ok) return reject("Statement contains an unterminated string, identifier, or comment");
  const scan = inspected.blanked;
  const statement = scan.trim();
  if (!statement) return reject("Enter one SAP ASE SELECT statement");
  if (!/^(?:SELECT|WITH)\b/i.test(statement)) {
    return reject("Only one SAP ASE SELECT or WITH statement is permitted");
  }
  if (/(?:^|\n)\s*GO(?:\s+\d+)?\s*;?\s*(?:\n|$)/i.test(scan)) {
    return reject("SAP ASE GO batch separators are not permitted");
  }
  const semicolons = [...scan.matchAll(/;/g)].map((match) => match.index!);
  if (semicolons.length > 1 || (semicolons.length === 1 && scan.slice(semicolons[0]! + 1).trim())) {
    return reject("Only one SQL statement is permitted");
  }
  let depth = 0;
  const topLevelWords: string[] = [];
  for (const token of scan.matchAll(/[()]|[A-Za-z_][A-Za-z0-9_$#@]*/g)) {
    if (token[0] === "(") { depth++; continue; }
    if (token[0] === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) topLevelWords.push(token[0].toUpperCase());
  }
  const selects = topLevelWords
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => word === "SELECT");
  if (selects.length > 1) {
    const invalid = selects.slice(1).some(({ index }) => {
      const previous = topLevelWords[index - 1];
      const beforePrevious = topLevelWords[index - 2];
      return previous !== "UNION"
        && previous !== "INTERSECT"
        && previous !== "EXCEPT"
        && !(previous === "ALL" && beforePrevious === "UNION");
    });
    if (invalid) return reject("Only one SQL statement is permitted");
  }
  if (/\bSELECT\b[\s\S]*?\bINTO\b/i.test(scan)) return reject("SAP ASE SELECT INTO is not permitted");
  if (/\bFOR\s+UPDATE\b/i.test(scan)) return reject("SAP ASE SELECT FOR UPDATE is not permitted");
  const unsafe = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|DBCC|DUMP|LOAD|BULK|SET|USE|COMMIT|ROLLBACK|BEGIN|SAVE|TRANSACTION|KILL|MOUNT|UNMOUNT|REORG|TRANSFER|WAITFOR)\b/i.exec(scan);
  if (unsafe) return reject(`SAP ASE ${unsafe[1]!.toUpperCase()} is not permitted`);
  return { ok: true, sql, isExplain: false };
}

export function boundSybaseCap(cap: number): number {
  const finite = Number.isFinite(cap) ? Math.floor(cap) : ROW_CAP;
  return Math.max(1, Math.min(ROW_CAP, finite));
}

function serializeForSize(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) ?? "null";
}

function makeExecuteReadOnly(factory: SybaseClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    rawSql: string,
    cap: number = ROW_CAP,
  ): Promise<QueryOutcome> => {
    const guarded = guardSybaseStatement(rawSql);
    if (!guarded.ok) return { ok: false, error: guarded.error };
    const bounded = boundSybaseCap(cap);
    let client: SybaseClient | undefined;
    let cursor: SybaseCursor | undefined;
    try {
      client = await factory(config, target);
      await readIdentityAndVerify(client, config.database);
      cursor = await client.openCursor(guarded.sql, bounded + 1);
      let bytes = 0;
      let rowCapped = false;
      let byteCapped = false;
      let columns: string[] = [];
      const shown: Record<string, unknown>[] = [];
      while (!rowCapped && !byteCapped) {
        const fetched = await cursor.fetch();
        const metadataColumns = fetched.columns?.map((column) => column.name ?? "").filter(Boolean) ?? [];
        if (!columns.length && metadataColumns.length) columns = metadataColumns;
        if (!fetched.length) break;
        if (!columns.length) columns = Object.keys(fetched[0]!);
        for (const row of fetched) {
          if (shown.length >= bounded) { rowCapped = true; break; }
          const size = Buffer.byteLength(serializeForSize(row));
          if (bytes + size > BYTE_CAP) { byteCapped = true; break; }
          shown.push(row);
          bytes += size;
        }
      }
      return {
        ok: true,
        columns,
        rows: shown,
        truncated: rowCapped || byteCapped,
        truncatedReason: byteCapped ? "bytes" : rowCapped ? "rows" : null,
      };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "query_failed") };
    } finally {
      if (cursor) {
        try { await cursor.close(); } catch { /* connection close is the final cleanup boundary */ }
      }
      await cleanup(client);
    }
  };
}

function validate(config: DatabaseConnectionConfig): DatabaseError | null {
  if (config.engine !== "sybase") {
    return { code: "unsupported_engine", message: "SAP ASE adapter received another engine", field: "engine" };
  }
  if (!config.host.trim() || config.host.length > 253 || /[\0\r\n]/.test(config.host)) {
    return { code: "invalid_configuration", message: config.host.trim() ? "Host is invalid" : "Host is required", field: "host" };
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    return { code: "invalid_configuration", message: "Port must be between 1 and 65535", field: "port" };
  }
  if (!config.database.trim() || config.database.length > 255 || /[\0\r\n]/.test(config.database)) {
    return { code: "invalid_configuration", message: config.database.trim() ? "Database name is invalid" : "Database name is required", field: "database" };
  }
  if (!config.username.trim() || config.username.length > 255 || /[\0\r\n]/.test(config.username)) {
    return { code: "invalid_configuration", message: config.username.trim() ? "Username is invalid" : "Username is required", field: "username" };
  }
  if (!config.password) return { code: "invalid_configuration", message: "Password is required", field: "password" };
  if (config.password.length > 4096 || /[\0\r\n]/.test(config.password)) {
    return { code: "invalid_configuration", message: "Password is invalid", field: "password" };
  }
  if (config.ssl.mode !== "disable") {
    return {
      code: "unsupported_capability",
      message: "SAP ASE TLS is not implemented; SSL mode must be disable",
      field: "ssl.mode",
    };
  }
  const tdsVersion = config.sybase?.tdsVersion?.trim() || SYBASE_DEFAULT_TDS_VERSION;
  if (tdsVersion !== SYBASE_DEFAULT_TDS_VERSION) {
    return { code: "invalid_configuration", message: "SAP ASE currently requires TDS version 5.0", field: "sybase.tdsVersion" };
  }
  const charset = config.sybase?.clientCharset?.trim() || SYBASE_DEFAULT_CLIENT_CHARSET;
  if (charset.length > 64 || !/^[A-Za-z0-9._-]+$/.test(charset)) {
    return { code: "invalid_configuration", message: "SAP ASE client charset is invalid", field: "sybase.clientCharset" };
  }
  return null;
}

function quoteIdentifier(identifier: string): string {
  return "[" + identifier.replaceAll("]", "]]") + "]";
}

export function createSybaseAdapter(factory: SybaseClientFactory = createSybaseOdbcClient): DatabaseAdapter {
  return {
    engine: "sybase",
    defaultPort: 5000,
    capabilities: {
      schemas: true,
      explain: false,
      sslModes: ["disable"],
      readOnlyTransactions: false,
      statementTimeout: true,
    },
    validate,
    quoteIdentifier,
    testConnection: makeTestConnection(factory),
    fetchCatalog: makeFetchCatalog(factory),
    executeReadOnly: makeExecuteReadOnly(factory),
  };
}

export const sybaseAdapter = createSybaseAdapter();
