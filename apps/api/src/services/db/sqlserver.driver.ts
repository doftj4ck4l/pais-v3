import { createRequire } from "node:module";
import { connect as connectTcp, isIP, type Socket } from "node:net";
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

const require = createRequire(import.meta.url);

// node-mssql is CommonJS and does not ship declarations. Keep the small
// runtime surface used here local rather than adding a second dependency.
type MssqlModule = {
  ConnectionPool: new (config: Record<string, unknown>) => {
    connect(): PromiseLike<unknown>;
    close(): PromiseLike<unknown>;
    request(config?: { requestTimeout?: number }): SqlServerRequest;
  };
  Transaction: new (pool: unknown, overrides?: { requestTimeout?: number }) => {
    begin(): PromiseLike<unknown>;
    rollback(): PromiseLike<unknown>;
  };
  Request: new (transaction: unknown, overrides?: { requestTimeout?: number }) => SqlServerRequest;
};

const mssql = require("mssql") as MssqlModule;

const STATEMENT_TIMEOUT_MS = 10_000;
const ROW_CAP = DATABASE_ROW_CAP;
const BYTE_CAP = DATABASE_BYTE_CAP;
export const SQLSERVER_IP_SNI_PLACEHOLDER = "pixelspace.invalid";

export type SqlServerRecordset = Record<string, unknown>[] & {
  columns?: Record<string, unknown>;
};

export type SqlServerQueryResult = {
  recordset?: SqlServerRecordset;
  recordsets?: SqlServerRecordset[];
};

export type SqlServerRequest = {
  timeout?: number;
  query(statement: string): PromiseLike<SqlServerQueryResult>;
};

export type SqlServerTransaction = {
  begin(): PromiseLike<unknown>;
  rollback(): PromiseLike<unknown>;
  request(): SqlServerRequest;
};

export type SqlServerClient = {
  connect(): PromiseLike<unknown>;
  close(): PromiseLike<unknown>;
  request(): SqlServerRequest;
  transaction(): SqlServerTransaction;
};

export type SqlServerClientFactory = (
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
) => SqlServerClient | PromiseLike<SqlServerClient>;

type SqlServerTlsSettings = {
  encrypt: boolean;
  trustServerCertificate: boolean;
  serverName?: string;
  cryptoCredentialsDetails?: { ca: string };
};

export function sqlserverTlsSettings(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
): SqlServerTlsSettings {
  if (config.ssl.mode === "disable") {
    return { encrypt: false, trustServerCertificate: true };
  }

  const configuredName = config.ssl.serverName?.trim() || target.originalHost;
  const serverName = config.ssl.mode === "require" && isIP(configuredName)
    ? SQLSERVER_IP_SNI_PLACEHOLDER
    : configuredName;

  return {
    encrypt: true,
    trustServerCertificate: config.ssl.mode === "require",
    serverName,
    ...(config.ssl.mode === "verify-full" && config.ssl.ca
      ? { cryptoCredentialsDetails: { ca: config.ssl.ca } }
      : {}),
  };
}

type SocketDialer = (options: { host: string; port: number }) => Socket;

/** Tedious receives a connected socket whose destination has already passed policy. */
export function createSqlServerConnector(
  target: ApprovedDatabaseTarget,
  port: number,
  dial: SocketDialer = connectTcp,
): () => Promise<Socket> {
  return () => new Promise<Socket>((resolve, reject) => {
    const socket = dial({ host: target.address, port });
    const timer = setTimeout(() => {
      cleanupListeners();
      socket.destroy();
      reject(Object.assign(new Error("SQL Server connection timeout"), { code: "ETIMEOUT" }));
    }, STATEMENT_TIMEOUT_MS);
    const cleanupListeners = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };
    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };
    const onConnect = () => {
      cleanupListeners();
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

export function sqlserverConnectionOptions(
  config: DatabaseConnectionConfig,
  target: ApprovedDatabaseTarget,
  dial?: SocketDialer,
): Record<string, unknown> {
  const tls = sqlserverTlsSettings(config, target);
  return {
    // `server` remains the configured identity. `connector` is the only dial
    // path and pins the socket to the policy-approved literal address.
    server: target.originalHost,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    connectionTimeout: STATEMENT_TIMEOUT_MS,
    requestTimeout: STATEMENT_TIMEOUT_MS,
    pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      enableArithAbort: true,
      appName: "Pixelspace",
      connector: createSqlServerConnector(target, config.port, dial),
      ...tls,
    },
  };
}

const nodeMssqlClient: SqlServerClientFactory = (config, target) => {
  const pool = new mssql.ConnectionPool(sqlserverConnectionOptions(config, target));
  return {
    connect: () => pool.connect(),
    close: () => pool.close(),
    request: () => pool.request({ requestTimeout: STATEMENT_TIMEOUT_MS }),
    transaction: () => {
      const transaction = new mssql.Transaction(pool, { requestTimeout: STATEMENT_TIMEOUT_MS });
      return {
        begin: () => transaction.begin(),
        rollback: () => transaction.rollback(),
        request: () => new mssql.Request(transaction, { requestTimeout: STATEMENT_TIMEOUT_MS }),
      };
    },
  };
};

class SqlServerAdapterError extends Error {
  constructor(readonly databaseError: DatabaseError) {
    super(databaseError.message);
  }
}

function scrub(message: string, config: Pick<DatabaseConnectionConfig, "password">): string {
  return scrubDatabaseMessage(message, config, "sqlserver://***");
}

function errorFacts(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as {
    code?: unknown;
    number?: unknown;
    originalError?: { code?: unknown; number?: unknown; message?: unknown };
  };
  return [
    value.code,
    value.number,
    value.originalError?.code,
    value.originalError?.number,
    value.originalError?.message,
  ].filter((part) => part != null).join(" ");
}

function databaseError(
  error: unknown,
  config: DatabaseConnectionConfig,
  fallback: DatabaseError["code"],
): DatabaseError {
  if (error instanceof SqlServerAdapterError) return error.databaseError;
  const message = scrub(error instanceof Error ? error.message : String(error), config);
  const facts = `${errorFacts(error)} ${message}`;
  if (/ETIMEOUT|request failed to complete in .*ms|timed? out|timeout/i.test(facts)) {
    return { code: "timeout", message: "Database statement timeout", retryable: true };
  }
  if (/\b(?:4060|911)\b|cannot open database|database .* (?:does not exist|is not accessible)/i.test(facts)) {
    return {
      code: "invalid_configuration",
      field: "database",
      message: `Database "${config.database}" does not exist or is not accessible`,
    };
  }
  if (/ELOGIN|\b18456\b|login failed|authentication failed/i.test(facts)) {
    return { code: "authentication_failed", message: "Database authentication failed" };
  }
  if (/ESOCKET|ECONNCLOSED|ENOTOPEN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(facts)) {
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

function rowsOf(result: SqlServerQueryResult): SqlServerRecordset {
  return result.recordset ?? ([] as unknown as SqlServerRecordset);
}

async function query(request: SqlServerRequest, statement: string): Promise<SqlServerQueryResult> {
  request.timeout = STATEMENT_TIMEOUT_MS;
  return await request.query(statement);
}

const IDENTITY_SQL = `
  SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS serverVersion,
         CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS productLevel,
         CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
         DB_NAME() AS databaseName,
         SUSER_SNAME() AS loginName,
         USER_NAME() AS databaseUser
`;

const PERMISSION_SQL = `
  SELECT CAST(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT') AS int) AS hasSelect,
         COALESCE(IS_MEMBER('db_datawriter'), 0) AS isDataWriter,
         COALESCE(IS_MEMBER('db_owner'), 0) AS isDbOwner,
         COALESCE(IS_MEMBER('db_ddladmin'), 0) AS isDbDdlAdmin,
         COALESCE(IS_MEMBER('db_accessadmin'), 0) AS isDbAccessAdmin,
         COALESCE(IS_MEMBER('db_securityadmin'), 0) AS isDbSecurityAdmin,
         COALESCE(IS_MEMBER('db_backupoperator'), 0) AS isDbBackupOperator,
         COALESCE(IS_SRVROLEMEMBER('sysadmin'), 0) AS isSysadmin,
         COALESCE(IS_SRVROLEMEMBER('serveradmin'), 0) AS isServerAdmin,
         COALESCE(IS_SRVROLEMEMBER('securityadmin'), 0) AS isSecurityAdmin,
         COALESCE(IS_SRVROLEMEMBER('setupadmin'), 0) AS isSetupAdmin,
         COALESCE(IS_SRVROLEMEMBER('processadmin'), 0) AS isProcessAdmin,
         COALESCE(IS_SRVROLEMEMBER('diskadmin'), 0) AS isDiskAdmin,
         COALESCE(IS_SRVROLEMEMBER('dbcreator'), 0) AS isDbCreator,
         COALESCE(IS_SRVROLEMEMBER('bulkadmin'), 0) AS isBulkAdmin,
         (SELECT COUNT(*) FROM sys.fn_my_permissions(NULL, 'DATABASE')
          WHERE permission_name IN (
            'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL', 'CREATE TABLE',
            'CREATE VIEW', 'CREATE PROCEDURE', 'CREATE FUNCTION', 'CREATE SCHEMA',
            'BACKUP DATABASE', 'BACKUP LOG', 'TAKE OWNERSHIP', 'IMPERSONATE',
            'CHECKPOINT', 'CONNECT REPLICATION', 'EXECUTE'
          )) AS dangerousDatabasePermissions,
         (SELECT COUNT(*) FROM sys.fn_my_permissions(NULL, 'SERVER')
          WHERE permission_name IN (
            'CONTROL SERVER', 'ALTER ANY LOGIN', 'ALTER ANY DATABASE',
            'CREATE ANY DATABASE', 'ALTER SERVER STATE', 'ALTER SERVER ROLE',
            'IMPERSONATE ANY LOGIN', 'SHUTDOWN', 'ADMINISTER BULK OPERATIONS'
          )) AS dangerousServerPermissions,
         (SELECT COUNT(*)
          FROM sys.schemas s
          CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name), 'SCHEMA') p
          WHERE p.permission_name IN (
            'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL', 'CREATE SEQUENCE',
            'TAKE OWNERSHIP', 'EXECUTE'
          )) AS dangerousSchemaPermissions,
         (SELECT COUNT(*)
          FROM sys.objects o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name) + '.' + QUOTENAME(o.name), 'OBJECT') p
          WHERE o.is_ms_shipped = 0
            AND p.permission_name IN (
              'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL', 'TAKE OWNERSHIP',
              'EXECUTE', 'REFERENCES', 'RECEIVE'
            )) AS dangerousObjectPermissions
`;

export function isReadOnlySqlServerPrincipal(row: Record<string, unknown>): boolean {
  const truthy = (name: string) => Number(rowValue(row, name) ?? 0) === 1;
  const positive = (name: string) => Number(rowValue(row, name) ?? 0) > 0;
  return truthy("hasSelect")
    && !truthy("isDataWriter")
    && !truthy("isDbOwner")
    && !truthy("isDbDdlAdmin")
    && !truthy("isDbAccessAdmin")
    && !truthy("isDbSecurityAdmin")
    && !truthy("isDbBackupOperator")
    && !truthy("isSysadmin")
    && !truthy("isServerAdmin")
    && !truthy("isSecurityAdmin")
    && !truthy("isSetupAdmin")
    && !truthy("isProcessAdmin")
    && !truthy("isDiskAdmin")
    && !truthy("isDbCreator")
    && !truthy("isBulkAdmin")
    && !positive("dangerousDatabasePermissions")
    && !positive("dangerousServerPermissions")
    && !positive("dangerousSchemaPermissions")
    && !positive("dangerousObjectPermissions");
}

async function readIdentityAndVerify(
  request: () => SqlServerRequest,
  expectedDatabase: string,
): Promise<{ serverVersion: string }> {
  const identity = rowsOf(await query(request(), IDENTITY_SQL))[0] ?? {};
  const selected = String(rowValue(identity, "databaseName") ?? "");
  if (!selected || selected.localeCompare(expectedDatabase, undefined, { sensitivity: "accent" }) !== 0) {
    throw new SqlServerAdapterError({
      code: "invalid_configuration",
      field: "database",
      message: `Database "${expectedDatabase}" was not selected by the server`,
    });
  }
  const permissions = rowsOf(await query(request(), PERMISSION_SQL))[0] ?? {};
  if (!isReadOnlySqlServerPrincipal(permissions)) {
    throw new SqlServerAdapterError({
      code: "unsupported_capability",
      message: "SQL Server connections require a read-only database login",
    });
  }
  return { serverVersion: String(rowValue(identity, "serverVersion") ?? "") };
}

async function cleanup(client: SqlServerClient | undefined): Promise<void> {
  if (!client) return;
  try { await client.close(); } catch { /* cleanup errors never expose connection details */ }
}

function makeTestConnection(factory: SqlServerClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
  ): Promise<DatabaseResult<{ serverVersion?: string; serverProduct?: "SQL Server" }>> => {
    let client: SqlServerClient | undefined;
    try {
      client = await factory(config, target);
      await client.connect();
      const identity = await readIdentityAndVerify(() => client!.request(), config.database);
      return {
        ok: true,
        value: { serverVersion: identity.serverVersion || undefined, serverProduct: "SQL Server" },
      };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "connection_failed") };
    } finally {
      await cleanup(client);
    }
  };
}

const TABLES_SQL = `
  SELECT s.name AS schemaName, o.name AS name,
         CAST(ep.value AS nvarchar(4000)) AS comment,
         COALESCE(SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END), 0) AS rowEstimate
  FROM sys.objects o
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  LEFT JOIN sys.extended_properties ep
    ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0
   AND ep.name = N'MS_Description'
  LEFT JOIN sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1)
  WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
  GROUP BY s.name, o.name, ep.value
  ORDER BY s.name, o.name
`;

const COLUMNS_SQL = `
  SELECT s.name AS schemaName, o.name AS tableName, c.column_id AS seq,
         c.name AS name,
         CASE
           WHEN TYPE_NAME(c.user_type_id) IN ('varchar', 'char', 'varbinary', 'binary')
             THEN TYPE_NAME(c.user_type_id) + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
           WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar', 'nchar')
             THEN TYPE_NAME(c.user_type_id) + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
           WHEN TYPE_NAME(c.user_type_id) IN ('decimal', 'numeric')
             THEN TYPE_NAME(c.user_type_id) + '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
           WHEN TYPE_NAME(c.user_type_id) IN ('datetime2', 'datetimeoffset', 'time')
             THEN TYPE_NAME(c.user_type_id) + '(' + CAST(c.scale AS varchar(10)) + ')'
           ELSE TYPE_NAME(c.user_type_id)
         END AS dataType,
         c.is_nullable AS nullable,
         CAST(ep.value AS nvarchar(4000)) AS comment
  FROM sys.columns c
  JOIN sys.objects o ON o.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  LEFT JOIN sys.extended_properties ep
    ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
   AND ep.name = N'MS_Description'
  WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
  ORDER BY s.name, o.name, c.column_id
`;

const PRIMARY_KEYS_SQL = `
  SELECT s.name AS schemaName, o.name AS tableName, c.name AS columnName,
         kc.name AS constraintName, ic.key_ordinal AS constraintOrdinal
  FROM sys.key_constraints kc
  JOIN sys.objects o ON o.object_id = kc.parent_object_id
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  JOIN sys.index_columns ic
    ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE kc.type = 'PK' AND o.is_ms_shipped = 0
  ORDER BY s.name, o.name, kc.name, ic.key_ordinal
`;

const FOREIGN_KEYS_SQL = `
  SELECT ps.name AS schemaName, po.name AS tableName, pc.name AS columnName,
         rs.name AS refSchema, ro.name AS refTable, rc.name AS refColumn,
         fkc.constraint_object_id AS constraintId,
         fkc.constraint_column_id AS constraintOrdinal
  FROM sys.foreign_key_columns fkc
  JOIN sys.objects po ON po.object_id = fkc.parent_object_id
  JOIN sys.schemas ps ON ps.schema_id = po.schema_id
  JOIN sys.columns pc
    ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
  JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
  JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
  JOIN sys.columns rc
    ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
  WHERE po.is_ms_shipped = 0 AND ro.is_ms_shipped = 0
  ORDER BY ps.name, po.name, fkc.constraint_object_id, fkc.constraint_column_id
`;

const INDEXES_SQL = `
  SELECT s.name AS schemaName, o.name AS tableName, i.name AS indexName,
         i.is_unique AS isUnique, i.type_desc AS typeDescription,
         i.filter_definition AS filterDefinition,
         ic.key_ordinal AS keyOrdinal, ic.index_column_id AS indexColumnId,
         ic.is_included_column AS isIncluded, ic.is_descending_key AS isDescending,
         c.name AS columnName
  FROM sys.indexes i
  JOIN sys.objects o ON o.object_id = i.object_id
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE o.type = 'U' AND o.is_ms_shipped = 0
    AND i.type <> 0 AND i.is_hypothetical = 0 AND i.name IS NOT NULL
  ORDER BY s.name, o.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id
`;

const compare = (...values: Array<[string, string]>): number => {
  for (const [left, right] of values) {
    const order = left.localeCompare(right);
    if (order) return order;
  }
  return 0;
};

function mapIndexes(rows: Record<string, unknown>[]): RawCatalog["indexes"] {
  type Group = {
    schemaName: string;
    tableName: string;
    indexName: string;
    unique: boolean;
    type: string;
    filter: string | null;
    keys: Array<{ ordinal: number; name: string; descending: boolean }>;
    includes: Array<{ ordinal: number; name: string }>;
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const schemaName = String(rowValue(row, "schemaName") ?? "");
    const tableName = String(rowValue(row, "tableName") ?? "");
    const indexName = String(rowValue(row, "indexName") ?? "");
    const key = `${schemaName}\0${tableName}\0${indexName}`;
    const group = groups.get(key) ?? {
      schemaName,
      tableName,
      indexName,
      unique: Boolean(rowValue(row, "isUnique")),
      type: String(rowValue(row, "typeDescription") ?? "INDEX").replaceAll("_", " ").toUpperCase(),
      filter: rowValue(row, "filterDefinition") == null ? null : String(rowValue(row, "filterDefinition")),
      keys: [],
      includes: [],
    };
    const columnName = rowValue(row, "columnName");
    if (columnName != null) {
      if (Boolean(rowValue(row, "isIncluded"))) {
        group.includes.push({ ordinal: Number(rowValue(row, "indexColumnId") ?? 0), name: String(columnName) });
      } else {
        group.keys.push({
          ordinal: Number(rowValue(row, "keyOrdinal") ?? 0),
          name: String(columnName),
          descending: Boolean(rowValue(row, "isDescending")),
        });
      }
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => compare([a.schemaName, b.schemaName], [a.tableName, b.tableName], [a.indexName, b.indexName]))
    .map((group) => {
      group.keys.sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));
      group.includes.sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));
      const keys = group.keys.map((column) =>
        `${quoteIdentifier(column.name)} ${column.descending ? "DESC" : "ASC"}`,
      );
      const include = group.includes.length
        ? ` INCLUDE (${group.includes.map((column) => quoteIdentifier(column.name)).join(", ")})`
        : "";
      const filter = group.filter ? ` WHERE ${group.filter}` : "";
      const type = group.type.endsWith("INDEX") ? group.type : `${group.type} INDEX`;
      return {
        schemaName: group.schemaName,
        tableName: group.tableName,
        definition: `${group.unique ? "UNIQUE " : ""}${type} ${quoteIdentifier(group.indexName)} (${keys.join(", ")})${include}${filter}`,
      };
    });
}

function makeFetchCatalog(factory: SqlServerClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    onStep?: (step: CatalogStep) => void,
  ): Promise<DatabaseResult<RawCatalog>> => {
    let client: SqlServerClient | undefined;
    try {
      client = await factory(config, target);
      await client.connect();
      await readIdentityAndVerify(() => client!.request(), config.database);

      const tableRows = rowsOf(await query(client.request(), TABLES_SQL));
      const tables = tableRows.map((row) => ({
        schemaName: String(rowValue(row, "schemaName") ?? ""),
        name: String(rowValue(row, "name") ?? ""),
        comment: rowValue(row, "comment") == null ? null : String(rowValue(row, "comment")),
        rowEstimate: Number(rowValue(row, "rowEstimate") ?? 0),
      })).sort((a, b) => compare([a.schemaName, b.schemaName], [a.name, b.name]));
      onStep?.({ step: "tables", count: tables.length });

      const columnRows = rowsOf(await query(client.request(), COLUMNS_SQL));
      const columns = columnRows.map((row) => ({
        schemaName: String(rowValue(row, "schemaName") ?? ""),
        tableName: String(rowValue(row, "tableName") ?? ""),
        seq: Number(rowValue(row, "seq") ?? 0),
        name: String(rowValue(row, "name") ?? ""),
        dataType: String(rowValue(row, "dataType") ?? ""),
        nullable: Boolean(rowValue(row, "nullable")),
        comment: rowValue(row, "comment") == null ? null : String(rowValue(row, "comment")),
      })).sort((a, b) => compare([a.schemaName, b.schemaName], [a.tableName, b.tableName]) || a.seq - b.seq);
      onStep?.({ step: "columns", count: columns.length });

      const pkRows = rowsOf(await query(client.request(), PRIMARY_KEYS_SQL));
      const primaryKeys = pkRows.sort((a, b) =>
        compare(
          [String(rowValue(a, "schemaName") ?? ""), String(rowValue(b, "schemaName") ?? "")],
          [String(rowValue(a, "tableName") ?? ""), String(rowValue(b, "tableName") ?? "")],
          [String(rowValue(a, "constraintName") ?? ""), String(rowValue(b, "constraintName") ?? "")],
        ) || Number(rowValue(a, "constraintOrdinal") ?? 0) - Number(rowValue(b, "constraintOrdinal") ?? 0),
      ).map((row) => ({
        schemaName: String(rowValue(row, "schemaName") ?? ""),
        tableName: String(rowValue(row, "tableName") ?? ""),
        columnName: String(rowValue(row, "columnName") ?? ""),
      }));
      onStep?.({ step: "primaryKeys", count: primaryKeys.length });

      const fkRows = rowsOf(await query(client.request(), FOREIGN_KEYS_SQL));
      const foreignKeys = fkRows.sort((a, b) =>
        compare(
          [String(rowValue(a, "schemaName") ?? ""), String(rowValue(b, "schemaName") ?? "")],
          [String(rowValue(a, "tableName") ?? ""), String(rowValue(b, "tableName") ?? "")],
          [String(rowValue(a, "constraintId") ?? ""), String(rowValue(b, "constraintId") ?? "")],
        ) || Number(rowValue(a, "constraintOrdinal") ?? 0) - Number(rowValue(b, "constraintOrdinal") ?? 0),
      ).map((row) => ({
        schemaName: String(rowValue(row, "schemaName") ?? ""),
        tableName: String(rowValue(row, "tableName") ?? ""),
        columnName: String(rowValue(row, "columnName") ?? ""),
        refSchema: String(rowValue(row, "refSchema") ?? ""),
        refTable: String(rowValue(row, "refTable") ?? ""),
        refColumn: String(rowValue(row, "refColumn") ?? ""),
      }));
      onStep?.({ step: "foreignKeys", count: foreignKeys.length });

      const indexes = mapIndexes(rowsOf(await query(client.request(), INDEXES_SQL)));
      onStep?.({ step: "indexes", count: indexes.length });
      return { ok: true, value: { tables, columns, primaryKeys, foreignKeys, indexes } };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "connection_failed") };
    } finally {
      await cleanup(client);
    }
  };
}

/** Blank T-SQL strings, nested comments, and quoted/bracketed identifiers. */
export function blankSqlServerLiteralsAndComments(sql: string): { blanked: string; ok: boolean } {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < out.length; index++) {
      if (out[index] !== "\n") out[index] = " ";
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
        if (sql.slice(index, index + 2) === "/*") {
          depth++;
          index += 2;
        } else if (sql.slice(index, index + 2) === "*/") {
          depth--;
          index += 2;
        } else {
          index++;
        }
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
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
        } else if (sql[index] === quote) {
          index++;
          terminated = true;
          break;
        } else {
          index++;
        }
      }
      if (!terminated) return { blanked: out.join(""), ok: false };
      blank(start, index);
      continue;
    }
    if (quote === "[") {
      const start = index++;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === "]" && sql[index + 1] === "]") {
          index += 2;
        } else if (sql[index] === "]") {
          index++;
          terminated = true;
          break;
        } else {
          index++;
        }
      }
      if (!terminated) return { blanked: out.join(""), ok: false };
      blank(start, index);
      continue;
    }
    index++;
  }
  return { blanked: out.join(""), ok: true };
}

export function guardSqlServerStatement(rawSql: string):
  | { ok: true; sql: string; isExplain: false }
  | { ok: false; error: DatabaseError } {
  const sql = rawSql.trim();
  const inspected = blankSqlServerLiteralsAndComments(sql);
  const reject = (message: string) => ({
    ok: false as const,
    error: { code: "query_rejected" as const, message },
  });
  if (!inspected.ok) return reject("Statement contains an unterminated string, identifier, or comment");
  const scan = inspected.blanked;
  const statement = scan.trim();
  if (!statement) return reject("Enter one SQL Server SELECT statement");
  if (!/^(?:SELECT|WITH)\b/i.test(statement)) {
    return reject("Only one SQL Server SELECT or WITH statement is permitted");
  }
  if (/(?:^|\n)\s*GO(?:\s+\d+)?\s*;?\s*(?:\n|$)/i.test(scan)) {
    return reject("SQL Server GO batch separators are not permitted");
  }
  const semicolons = [...scan.matchAll(/;/g)].map((match) => match.index!);
  if (semicolons.length > 1 || (semicolons.length === 1 && scan.slice(semicolons[0]! + 1).trim())) {
    return reject("Only one SQL statement is permitted");
  }
  if (/\bSELECT\b[\s\S]*?\bINTO\b/i.test(scan)) {
    return reject("SQL Server SELECT INTO is not permitted");
  }
  const unsafe = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|DBCC|BACKUP|RESTORE|BULK|SET|USE|COMMIT|ROLLBACK|BEGIN|SAVE|TRANSACTION|OPENROWSET|OPENQUERY|OPENDATASOURCE|OPENXML)\b/i.exec(scan);
  if (unsafe) return reject(`SQL Server ${unsafe[1]!.toUpperCase()} is not permitted`);
  return { ok: true, sql, isExplain: false };
}

export function boundSqlServerCap(cap: number): number {
  const finite = Number.isFinite(cap) ? Math.floor(cap) : ROW_CAP;
  return Math.max(1, Math.min(ROW_CAP, finite));
}

function serializeForSize(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) ?? "null";
}

function makeExecuteReadOnly(factory: SqlServerClientFactory) {
  return async (
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    rawSql: string,
    cap: number = ROW_CAP,
  ): Promise<QueryOutcome> => {
    const guarded = guardSqlServerStatement(rawSql);
    if (!guarded.ok) return { ok: false, error: guarded.error };
    const bounded = boundSqlServerCap(cap);
    let client: SqlServerClient | undefined;
    let transaction: SqlServerTransaction | undefined;
    try {
      client = await factory(config, target);
      await client.connect();
      transaction = client.transaction();
      await transaction.begin();
      await readIdentityAndVerify(() => transaction!.request(), config.database);
      await query(transaction.request(), `SET ROWCOUNT ${bounded + 1}`);
      const result = await query(transaction.request(), guarded.sql);
      const rows = rowsOf(result);
      const rowCapped = rows.length > bounded;
      const rowLimited = rowCapped ? rows.slice(0, bounded) : [...rows];
      const metadataColumns = rows.columns ? Object.keys(rows.columns) : [];
      const columns = metadataColumns.length
        ? metadataColumns
        : rowLimited.length ? Object.keys(rowLimited[0]!) : [];

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
        columns,
        rows: shown,
        truncated: rowCapped || byteCapped,
        truncatedReason: byteCapped ? "bytes" : rowCapped ? "rows" : null,
      };
    } catch (error) {
      return { ok: false, error: databaseError(error, config, "query_failed") };
    } finally {
      if (transaction) {
        try { await transaction.rollback(); } catch { /* pool close is the final cleanup boundary */ }
      }
      await cleanup(client);
    }
  };
}

function validate(config: DatabaseConnectionConfig): DatabaseError | null {
  if (config.engine !== "sqlserver") {
    return { code: "unsupported_engine", message: "SQL Server adapter received another engine", field: "engine" };
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
    return { code: "invalid_configuration", message: "Unsupported SQL Server SSL mode", field: "ssl.mode" };
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
      message: "SQL Server verify-full requires a DNS TLS server name when the connection host is an IP address",
      field: "ssl.serverName",
    };
  }
  return null;
}

function quoteIdentifier(identifier: string): string {
  return "[" + identifier.replaceAll("]", "]]") + "]";
}

export function createSqlServerAdapter(factory: SqlServerClientFactory = nodeMssqlClient): DatabaseAdapter {
  return {
    engine: "sqlserver",
    defaultPort: 1433,
    capabilities: {
      schemas: true,
      explain: false,
      sslModes: ["disable", "require", "verify-full"],
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

export const sqlserverAdapter = createSqlServerAdapter();
