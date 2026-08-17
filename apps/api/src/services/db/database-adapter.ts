/**
 * Engine-neutral contract between the API/agent tools and database drivers.
 *
 * Adding an engine means implementing this interface and registering it. The
 * public API, encrypted store, schema snapshot, and agent tools do not branch
 * on an engine name.
 */

export type DatabaseEngine = "postgresql" | (string & {});

export type DatabaseSslMode = "disable" | "require" | "verify-full";

export type DatabaseSslOptions = {
  mode: DatabaseSslMode;
  /** PEM CA bundle. Secret-adjacent configuration: encrypted and never returned. */
  ca?: string | null;
  /** TLS identity when connecting to a DNS-pinned address. Defaults to host. */
  serverName?: string | null;
};

export type DatabaseConnectionConfig = {
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: DatabaseSslOptions;
};

export type ApprovedDatabaseTarget = {
  /** User-configured host, retained for TLS SNI/certificate verification. */
  originalHost: string;
  /** A policy-approved literal address. Drivers must connect to this value. */
  address: string;
  family: 4 | 6;
};

export type DatabaseErrorCode =
  | "invalid_configuration"
  | "unsupported_engine"
  | "target_not_allowed"
  | "dns_resolution_failed"
  | "connection_failed"
  | "authentication_failed"
  | "timeout"
  | "query_rejected"
  | "query_failed";

export type DatabaseError = {
  code: DatabaseErrorCode;
  message: string;
  field?: string;
  retryable?: boolean;
};

export type DatabaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DatabaseError };

export type CatalogStep = {
  step: "tables" | "columns" | "primaryKeys" | "foreignKeys" | "indexes";
  count: number;
};

export type RawCatalog = {
  tables: { schemaName: string; name: string; comment: string | null; rowEstimate: number }[];
  columns: {
    schemaName: string;
    tableName: string;
    seq: number;
    name: string;
    dataType: string;
    nullable: boolean;
    comment: string | null;
  }[];
  primaryKeys: { schemaName: string; tableName: string; columnName: string }[];
  foreignKeys: {
    schemaName: string;
    tableName: string;
    columnName: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
  }[];
  indexes: { schemaName: string; tableName: string; definition: string }[];
};

export type QueryOutcome =
  | {
      ok: true;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
      truncatedReason?: "rows" | "bytes" | null;
    }
  | { ok: false; error: DatabaseError };

export type DatabaseAdapterCapabilities = {
  schemas: boolean;
  explain: boolean;
  sslModes: readonly DatabaseSslMode[];
  readOnlyTransactions: boolean;
  statementTimeout: boolean;
};

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  readonly defaultPort: number;
  readonly capabilities: DatabaseAdapterCapabilities;

  validate(config: DatabaseConnectionConfig): DatabaseError | null;
  quoteIdentifier(identifier: string): string;
  testConnection(
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
  ): Promise<DatabaseResult<{ serverVersion?: string }>>;
  fetchCatalog(
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    onStep?: (step: CatalogStep) => void,
  ): Promise<DatabaseResult<RawCatalog>>;
  executeReadOnly(
    config: DatabaseConnectionConfig,
    target: ApprovedDatabaseTarget,
    sql: string,
    cap?: number,
  ): Promise<QueryOutcome>;
}

/** Final common redaction boundary for any current or future driver. */
export function scrubDatabaseMessage(
  message: string,
  config: Pick<DatabaseConnectionConfig, "password">,
  urlReplacement = "database://***",
): string {
  let scrubbed = message.replace(/(?:postgres(?:ql)?|mysql|mssql):\/\/[^\s"']+/gi, urlReplacement);
  if (config.password) {
    scrubbed = scrubbed.split(config.password).join("***");
    const encoded = encodeURIComponent(config.password);
    if (encoded !== config.password) scrubbed = scrubbed.split(encoded).join("***");
  }
  return scrubbed.replace(/\/\/[^/@\s]*@/g, "//***@");
}

export function redactDatabaseError(
  error: DatabaseError,
  config: Pick<DatabaseConnectionConfig, "password">,
): DatabaseError {
  return { ...error, message: scrubDatabaseMessage(error.message, config) };
}
