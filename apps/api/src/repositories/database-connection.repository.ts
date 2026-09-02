import { and, eq, sql } from "drizzle-orm";
import { db, dbConnections, dbTables, dbColumns } from "../db/client";
import type { DbConnectionRow, DbConnectionStatus, DbColumnRow } from "../models/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { SnapshotTable } from "../services/db/introspect.service";
import type {
  DatabaseConnectionConfig,
  DatabaseEngine,
  DatabaseSslMode,
} from "../services/db/database-adapter";

/**
 * The only thing that touches `db_connections`, `db_tables`, `db_columns`, and
 * `db_schema_fts`.
 *
 * `list` deliberately selects columns rather than `select()`: the encrypted
 * secret must never leave this module by accident, and an explicit column list
 * is the only way that stays true when the table gains a field.
 */

export type NewConnection = {
  id: string;
  workspaceId: string;
  name: string;
  config: DatabaseConnectionConfig;
  // Lets a caller that already knows the outcome of a reachability probe (see
  // database.controller.ts) store the row as already-correct, rather than
  // inserting "connected" and immediately correcting it — the gap between
  // those two writes is otherwise visible to a concurrent read.
  status?: DbConnectionStatus;
  error?: string | null;
};

export type DatabaseConnectionUpdate = {
  name: string;
  config: DatabaseConnectionConfig;
  status: DbConnectionStatus;
  error: string | null;
};

/**
 * Thrown by `create()` when the DB-level unique index on (workspace_id, name) is
 * hit by a request that slipped past the caller's own pre-check — two inserts
 * for the same name racing each other. Lets the controller map the race to
 * the same 409 the pre-check returns, instead of a bare 500.
 */
export class DuplicateConnectionNameError extends Error {
  constructor(public readonly connectionName: string) {
    super(`A connection named "${connectionName}" already exists`);
    this.name = "DuplicateConnectionNameError";
  }
}

/**
 * bun:sqlite reports a violated UNIQUE index via `error.code`, not by message
 * text alone, so this checks the code first. The table also has a PRIMARY KEY
 * uniqueness on `id`; the message-text check narrows this to the (workspace_id,
 * name) index specifically, so an id collision (which should never happen —
 * ids are randomly generated) is not misreported as a duplicate name.
 */
function isDuplicateNameViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    e.message.includes("db_connections.name")
  );
}

export type ConnectionInventoryEntry = { name: string; tableCount: number; tables: string[] };

export type TableDetail = {
  connectionName: string;
  schemaName: string;
  name: string;
  comment: string | null;
  rowEstimate: number;
  indexes: string[];
  columns: DbColumnRow[];
  // The OTHER schema names (besides the one resolved into `schemaName`) that
  // also hold a table of this name in this connection. Empty when the bare
  // name was unambiguous. A bare-name lookup across non-public schemas has no
  // natural tiebreaker, so this is how the caller finds out it guessed.
  alternateSchemas: string[];
};

export type SchemaHit = {
  connectionName: string;
  schemaName: string;
  tableName: string;
  columnName: string | null;
  detail: string;
  score: number;
};

export type ResolvedDatabaseConnection = {
  row: DbConnectionRow;
  config: DatabaseConnectionConfig;
};

export interface DatabaseConnectionStore {
  create(conn: NewConnection): Promise<void>;
  update(
    workspaceId: string,
    id: string,
    update: DatabaseConnectionUpdate,
  ): Promise<boolean>;
  list(workspaceId: string): Promise<DbConnectionRow[]>;
  findById(workspaceId: string, id: string): Promise<DbConnectionRow | null>;
  findByName(workspaceId: string, name: string): Promise<DbConnectionRow | null>;
  resolveConnection(workspaceId: string, connectionId: string): Promise<ResolvedDatabaseConnection | null>;
  resolveConfig(workspaceId: string, connectionId: string): Promise<DatabaseConnectionConfig | null>;
  markStatus(
    workspaceId: string,
    id: string,
    status: DbConnectionStatus,
    error: string | null,
  ): Promise<void>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  saveSnapshot(connectionId: string, workspaceId: string, tables: SnapshotTable[]): Promise<void>;
  inventory(workspaceId: string): Promise<ConnectionInventoryEntry[]>;
  describeTable(workspaceId: string, connectionName: string, table: string): Promise<TableDetail | null>;
  searchSchema(
    workspaceId: string, ftsQuery: string, connectionName: string | null, limit: number,
  ): Promise<SchemaHit[]>;
}

const PUBLIC_COLUMNS = {
  id: dbConnections.id,
  workspaceId: dbConnections.workspaceId,
  name: dbConnections.name,
  engine: dbConnections.engine,
  status: dbConnections.status,
  error: dbConnections.error,
  host: dbConnections.host,
  port: dbConnections.port,
  database: dbConnections.database,
  username: dbConnections.username,
  sslMode: dbConnections.sslMode,
  hasCustomCa: dbConnections.hasCustomCa,
  tableCount: dbConnections.tableCount,
  lastIntrospectedAt: dbConnections.lastIntrospectedAt,
  createdAt: dbConnections.createdAt,
};

type StoredSecretV2 = {
  version: 2;
  password: string;
  sslCa: string | null;
  sslServerName: string | null;
};

const normalizeEngine = (engine: string): DatabaseEngine => {
  if (engine === "postgres" || engine === "postgresql") return "postgresql";
  if (engine === "mysql") return "mysql";
  throw new Error(`Unsupported stored database engine: ${engine}`);
};

function encodeSecret(config: DatabaseConnectionConfig): string {
  const value: StoredSecretV2 = {
    version: 2,
    password: config.password,
    sslCa: config.ssl.ca ?? null,
    sslServerName: config.ssl.serverName ?? null,
  };
  return encryptSecret(JSON.stringify(value));
}

function decodeConfig(row: {
  engine: string;
  secret: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: string;
}): DatabaseConnectionConfig {
  const plaintext = decryptSecret(row.secret);
  try {
    const parsed = JSON.parse(plaintext) as StoredSecretV2;
    if (parsed.version === 2 && typeof parsed.password === "string") {
      return {
        engine: normalizeEngine(row.engine),
        host: row.host,
        port: row.port,
        database: row.database,
        username: row.username,
        password: parsed.password,
        ssl: {
          mode: row.sslMode as DatabaseSslMode,
          ca: parsed.sslCa,
          serverName: parsed.sslServerName,
        },
      };
    }
  } catch {
    // Pre-structured rows encrypted a full PostgreSQL URL. Decode them only in
    // this private resolution path so existing connections keep working.
  }

  const legacy = new URL(plaintext);
  const legacyMode = legacy.searchParams.get("sslmode");
  return {
    engine: "postgresql",
    host: legacy.hostname || row.host,
    port: Number(legacy.port || row.port || 5432),
    database: legacy.pathname.replace(/^\//, "") || row.database,
    username: decodeURIComponent(legacy.username || row.username),
    password: decodeURIComponent(legacy.password),
    ssl: {
      mode: legacyMode === "require" ? "require" : legacyMode === "verify-full" ? "verify-full" : "disable",
    },
  };
}

function publicRow(row: any): DbConnectionRow {
  return {
    ...row,
    engine: normalizeEngine(row.engine),
    sslMode: row.sslMode as DbConnectionRow["sslMode"],
  };
}

export class SqliteDatabaseConnectionStore implements DatabaseConnectionStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(conn: NewConnection): Promise<void> {
    try {
      await this.dbImpl.insert(dbConnections).values({
        id: conn.id,
        workspaceId: conn.workspaceId,
        name: conn.name,
        engine: conn.config.engine,
        secret: encodeSecret(conn.config),
        host: conn.config.host,
        port: conn.config.port,
        database: conn.config.database,
        username: conn.config.username,
        sslMode: conn.config.ssl.mode,
        hasCustomCa: Boolean(conn.config.ssl.ca),
        status: conn.status ?? "connected",
        error: conn.error ?? null,
        tableCount: 0,
        lastIntrospectedAt: null,
        createdAt: Date.now(),
      });
    } catch (e) {
      if (isDuplicateNameViolation(e)) throw new DuplicateConnectionNameError(conn.name);
      throw e;
    }
  }

  async update(
    workspaceId: string,
    id: string,
    update: DatabaseConnectionUpdate,
  ): Promise<boolean> {
    try {
      // Drizzle's Bun SQLite update result is typed as void, so use the
      // underlying prepared statement here to observe the atomic affected-row
      // count instead of doing a racy SELECT-before-UPDATE ownership check.
      const result = this.dbImpl.$client.query(`
        UPDATE db_connections
        SET name = ?, engine = ?, secret = ?, display_host = ?, port = ?,
            display_database = ?, username = ?, ssl_mode = ?, has_custom_ca = ?,
            status = ?, error = ?
        WHERE workspace_id = ? AND id = ?
      `).run(
        update.name,
        update.config.engine,
        encodeSecret(update.config),
        update.config.host,
        update.config.port,
        update.config.database,
        update.config.username,
        update.config.ssl.mode,
        Boolean(update.config.ssl.ca),
        update.status,
        update.error,
        workspaceId,
        id,
      );
      return result.changes > 0;
    } catch (e) {
      if (isDuplicateNameViolation(e)) throw new DuplicateConnectionNameError(update.name);
      throw e;
    }
  }

  async list(workspaceId: string): Promise<DbConnectionRow[]> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(eq(dbConnections.workspaceId, workspaceId))
      .orderBy(sql`created_at desc`);
    return rows.map(publicRow);
  }

  async findById(workspaceId: string, id: string): Promise<DbConnectionRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, id)));
    return rows[0] ? publicRow(rows[0]) : null;
  }

  async findByName(workspaceId: string, name: string): Promise<DbConnectionRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.name, name)));
    return rows[0] ? publicRow(rows[0]) : null;
  }

  /** Decrypts only after confirming the caller owns the row. */
  async resolveConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ResolvedDatabaseConnection | null> {
    const rows = await this.dbImpl
      .select({ ...PUBLIC_COLUMNS, secret: dbConnections.secret })
      .from(dbConnections)
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, connectionId)));
    if (!rows[0]) return null;
    const { secret: _secret, ...safeFields } = rows[0];
    return { row: publicRow(safeFields), config: decodeConfig(rows[0]) };
  }

  /** Decrypts only after confirming the caller owns the row. */
  async resolveConfig(workspaceId: string, connectionId: string): Promise<DatabaseConnectionConfig | null> {
    const rows = await this.dbImpl
      .select({
        engine: dbConnections.engine,
        secret: dbConnections.secret,
        host: dbConnections.host,
        port: dbConnections.port,
        database: dbConnections.database,
        username: dbConnections.username,
        sslMode: dbConnections.sslMode,
      })
      .from(dbConnections)
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, connectionId)));
    return rows[0] ? decodeConfig(rows[0]) : null;
  }

  async markStatus(
    workspaceId: string,
    id: string,
    status: DbConnectionStatus,
    error: string | null,
  ): Promise<void> {
    await this.dbImpl
      .update(dbConnections)
      .set({ status, error })
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, id)));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const owned = await this.dbImpl
      .select({ id: dbConnections.id })
      .from(dbConnections)
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, id)));
    if (!owned.length) return false;

    this.dbImpl.transaction((tx) => {
      // db_tables and db_columns cascade; the FTS mirror is virtual and has no
      // foreign keys, so it is cleared explicitly — same as chunks_fts.
      //
      // The ownership check above already guarantees `id` belongs to `workspaceId`
      // before this runs, so scoping by `workspaceId` here too is redundant for
      // correctness today. It is kept anyway, consistent with every other
      // write in this file (see `saveSnapshot`): a future caller that skips
      // the pre-check gets a no-op instead of touching someone else's row.
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id = ${id}`);
      tx.delete(dbConnections)
        .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, id)))
        .run();
    });
    return true;
  }

  /**
   * Replace a connection's snapshot wholesale.
   *
   * Delete-then-insert in one transaction rather than a diff: a schema is small,
   * a refresh is rare, and a partial diff would leave the FTS mirror describing
   * columns that no longer exist — which the agent would then write SQL against.
   */
  async saveSnapshot(
    connectionId: string,
    workspaceId: string,
    tables: SnapshotTable[],
  ): Promise<void> {
    // Ownership pre-check, same shape as `remove()`. It matters more here
    // than it looks: `db_schema_fts` has no `workspace_id` column (it is an FTS5
    // virtual table mirroring `db_tables`/`db_columns`, both UNINDEXED
    // columns aside), so its own DELETE below cannot be scoped by workspaceId at
    // all. Without this pre-check, a mismatched `workspaceId` would still wipe
    // the real owner's FTS index for this connection even though the
    // workspaceId-scoped writes further down became no-ops — a partial failure
    // instead of the complete no-op this fix requires.
    const owned = await this.dbImpl
      .select({ id: dbConnections.id })
      .from(dbConnections)
      .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, connectionId)));
    if (!owned.length) return;

    this.dbImpl.transaction((tx) => {
      // Every write below is scoped by BOTH `workspaceId` and `connectionId`, not
      // `connectionId` alone. `saveSnapshot`'s only caller (introspection,
      // after `create`/`refresh`) always proves ownership first, so this is
      // not exploitable today — but it is the one write path in this file
      // that used to filter on id only, which made a mismatched `workspaceId`
      // silently mutate and read back someone else's connection instead of
      // being a no-op, unlike every other method here.
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id = ${connectionId}`);
      tx.delete(dbTables)
        .where(and(eq(dbTables.workspaceId, workspaceId), eq(dbTables.connectionId, connectionId)))
        .run();

      for (const t of tables) {
        const tableId = `${connectionId}:${t.schemaName}.${t.name}`;
        tx.insert(dbTables)
          .values({
            id: tableId,
            connectionId,
            workspaceId,
            schemaName: t.schemaName,
            name: t.name,
            comment: t.comment,
            rowEstimate: t.rowEstimate,
            columnCount: t.columns.length,
            indexes: JSON.stringify(t.indexes),
          })
          .run();

        // The table's own FTS row carries its column names too, so a search for
        // a column term still surfaces the table that holds it.
        tx.run(sql`
          INSERT INTO db_schema_fts (text, object_id, connection_id, kind)
          VALUES (
            ${[t.name, t.comment ?? "", t.columns.map((c) => c.name).join(" ")].join(" ")},
            ${tableId}, ${connectionId}, 'table'
          )
        `);

        for (const c of t.columns) {
          const columnId = `${tableId}#${c.name}`;
          tx.insert(dbColumns)
            .values({
              id: columnId,
              tableId,
              connectionId,
              workspaceId,
              seq: c.seq,
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable ? 1 : 0,
              isPrimaryKey: c.isPrimaryKey ? 1 : 0,
              fkTable: c.fkTable,
              fkColumn: c.fkColumn,
              comment: c.comment,
            })
            .run();

          tx.run(sql`
            INSERT INTO db_schema_fts (text, object_id, connection_id, kind)
            VALUES (
              ${[t.name, c.name, c.comment ?? ""].join(" ")},
              ${columnId}, ${connectionId}, 'column'
            )
          `);
        }
      }

      tx.update(dbConnections)
        .set({
          status: "connected",
          error: null,
          tableCount: tables.length,
          lastIntrospectedAt: Date.now(),
        })
        .where(and(eq(dbConnections.workspaceId, workspaceId), eq(dbConnections.id, connectionId)))
        .run();
    });
  }

  /** Connection names and their table names — everything the system prompt needs. */
  async inventory(workspaceId: string): Promise<ConnectionInventoryEntry[]> {
    const rows = (await this.dbImpl.all(sql`
      SELECT c.name AS connectionName, c.table_count AS tableCount,
             t.schema_name AS schemaName, t.name AS tableName
      FROM db_connections c
      LEFT JOIN db_tables t ON t.connection_id = c.id
      WHERE c.workspace_id = ${workspaceId} AND c.status = 'connected'
      ORDER BY c.name, t.schema_name, t.name
    `)) as {
      connectionName: string; tableCount: number;
      schemaName: string | null; tableName: string | null;
    }[];

    const byConnection = new Map<string, ConnectionInventoryEntry>();
    for (const r of rows) {
      const entry = byConnection.get(r.connectionName) ?? {
        name: r.connectionName,
        tableCount: r.tableCount,
        tables: [],
      };
      if (r.tableName) {
        // The schema is only shown when it is not `public`, which keeps the
        // common case terse without making a multi-schema database ambiguous.
        entry.tables.push(r.schemaName === "public" ? r.tableName : `${r.schemaName}.${r.tableName}`);
      }
      byConnection.set(r.connectionName, entry);
    }
    return [...byConnection.values()];
  }

  /**
   * Full detail for one table. `table` may be bare (`orders`) or qualified
   * (`public.orders`) — the agent sees both forms in the inventory, so both
   * must resolve.
   */
  async describeTable(
    workspaceId: string,
    connectionName: string,
    table: string,
  ): Promise<TableDetail | null> {
    // `split(".", 2)` splits on EVERY "." and then truncates — it silently
    // drops anything past the second segment (`"a.b.c".split(".", 2)` is
    // `["a","b"]`, not `["a","b.c"]`). A qualified name is "schema" + "the
    // rest", so split on the first dot only.
    const dot = table.indexOf(".");
    const maybeSchema = dot > -1 ? table.slice(0, dot) : null;
    const maybeName = dot > -1 ? table.slice(dot + 1) : table;

    const rows = (await this.dbImpl.all(sql`
      SELECT t.id AS tableId, t.schema_name AS schemaName, t.name AS name,
             t.comment AS comment, t.row_estimate AS rowEstimate, t.indexes AS indexes
      FROM db_tables t
      JOIN db_connections c ON c.id = t.connection_id
      WHERE c.workspace_id = ${workspaceId} AND c.name = ${connectionName} AND c.status = 'connected'
        AND t.name = ${maybeName}
        AND (${maybeSchema} IS NULL OR t.schema_name = ${maybeSchema})
      ORDER BY CASE t.schema_name WHEN 'public' THEN 0 ELSE 1 END, t.schema_name ASC
    `)) as {
      tableId: string; schemaName: string; name: string;
      comment: string | null; rowEstimate: number; indexes: string | null;
    }[];

    const hit = rows[0];
    if (!hit) return null;

    const columns = (await this.dbImpl
      .select()
      .from(dbColumns)
      .where(eq(dbColumns.tableId, hit.tableId))
      .orderBy(sql`seq asc`)) as DbColumnRow[];

    return {
      connectionName,
      schemaName: hit.schemaName,
      name: hit.name,
      comment: hit.comment,
      rowEstimate: hit.rowEstimate,
      indexes: hit.indexes ? (JSON.parse(hit.indexes) as string[]) : [],
      columns,
      // Every OTHER schema among the candidate rows also holds a table of this
      // name in this connection — the resolution above picked `hit`, but the
      // agent should be told it was a guess.
      alternateSchemas: rows.slice(1).map((r) => r.schemaName),
    };
  }

  /** Rank tables and columns against a prepared FTS5 query. */
  async searchSchema(
    workspaceId: string,
    ftsQuery: string,
    connectionName: string | null,
    limit: number,
  ): Promise<SchemaHit[]> {
    return (await this.dbImpl.all(sql`
      SELECT c.name AS connectionName,
             COALESCE(t.schema_name, ct.schema_name) AS schemaName,
             COALESCE(t.name, ct.name)              AS tableName,
             col.name                                AS columnName,
             CASE
               WHEN col.id IS NOT NULL
                 THEN col.data_type || COALESCE(' — ' || col.comment, '')
               ELSE COALESCE(t.comment, t.column_count || ' columns')
             END AS detail,
             -bm25(db_schema_fts) AS score
      FROM db_schema_fts
      JOIN db_connections c ON c.id = db_schema_fts.connection_id
      LEFT JOIN db_tables  t   ON t.id   = db_schema_fts.object_id
      LEFT JOIN db_columns col ON col.id = db_schema_fts.object_id
      LEFT JOIN db_tables  ct  ON ct.id  = col.table_id
      WHERE db_schema_fts MATCH ${ftsQuery}
        AND c.workspace_id = ${workspaceId}
        -- A snapshot from a connection whose last re-introspection failed is
        -- exactly the "plausible but wrong" input this design exists to avoid:
        -- it already dropped out of inventory(), so it must not still resolve
        -- here or in describeTable. The user sees the error and can refresh.
        AND c.status = 'connected'
        AND (${connectionName} IS NULL OR c.name = ${connectionName})
      ORDER BY score DESC
      LIMIT ${limit}
    `)) as SchemaHit[];
  }

  /** Test-only: proves the stored value is ciphertext, not a URL. */
  async debugRawSecret(id: string): Promise<string | null> {
    const rows = await this.dbImpl
      .select({ secret: dbConnections.secret })
      .from(dbConnections)
      .where(eq(dbConnections.id, id));
    return rows[0]?.secret ?? null;
  }
}

export const databaseConnectionStore: DatabaseConnectionStore = new SqliteDatabaseConnectionStore();
