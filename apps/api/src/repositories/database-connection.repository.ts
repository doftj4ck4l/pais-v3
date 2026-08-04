import { and, eq, sql } from "drizzle-orm";
import { db, dbConnections, dbTables, dbColumns } from "../db/client";
import type { DbConnectionRow, DbConnectionStatus, DbColumnRow } from "../models/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { SnapshotTable } from "../services/db/introspect.service";

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
  userId: string;
  name: string;
  url: string;
  displayHost: string;
  displayDatabase: string;
};

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

export interface DatabaseConnectionStore {
  create(conn: NewConnection): Promise<void>;
  list(userId: string): Promise<DbConnectionRow[]>;
  findByName(userId: string, name: string): Promise<DbConnectionRow | null>;
  resolveUrl(userId: string, connectionId: string): Promise<string | null>;
  markStatus(id: string, status: DbConnectionStatus, error: string | null): Promise<void>;
  remove(userId: string, id: string): Promise<boolean>;
  saveSnapshot(connectionId: string, userId: string, tables: SnapshotTable[]): Promise<void>;
  inventory(userId: string): Promise<ConnectionInventoryEntry[]>;
  describeTable(userId: string, connectionName: string, table: string): Promise<TableDetail | null>;
  searchSchema(
    userId: string, ftsQuery: string, connectionName: string | null, limit: number,
  ): Promise<SchemaHit[]>;
}

const PUBLIC_COLUMNS = {
  id: dbConnections.id,
  userId: dbConnections.userId,
  name: dbConnections.name,
  engine: dbConnections.engine,
  status: dbConnections.status,
  error: dbConnections.error,
  displayHost: dbConnections.displayHost,
  displayDatabase: dbConnections.displayDatabase,
  tableCount: dbConnections.tableCount,
  lastIntrospectedAt: dbConnections.lastIntrospectedAt,
  createdAt: dbConnections.createdAt,
};

export class SqliteDatabaseConnectionStore implements DatabaseConnectionStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(conn: NewConnection): Promise<void> {
    await this.dbImpl.insert(dbConnections).values({
      id: conn.id,
      userId: conn.userId,
      name: conn.name,
      engine: "postgres",
      secret: encryptSecret(conn.url),
      displayHost: conn.displayHost,
      displayDatabase: conn.displayDatabase,
      status: "connected",
      error: null,
      tableCount: 0,
      lastIntrospectedAt: null,
      createdAt: Date.now(),
    });
  }

  async list(userId: string): Promise<DbConnectionRow[]> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(eq(dbConnections.userId, userId))
      .orderBy(sql`created_at desc`);
    return rows as DbConnectionRow[];
  }

  async findByName(userId: string, name: string): Promise<DbConnectionRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.name, name)));
    return (rows[0] as DbConnectionRow) ?? null;
  }

  /** Decrypts only after confirming the caller owns the row. */
  async resolveUrl(userId: string, connectionId: string): Promise<string | null> {
    const rows = await this.dbImpl
      .select({ secret: dbConnections.secret })
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.id, connectionId)));
    const secret = rows[0]?.secret;
    return secret ? decryptSecret(secret) : null;
  }

  async markStatus(
    id: string,
    status: DbConnectionStatus,
    error: string | null,
  ): Promise<void> {
    await this.dbImpl
      .update(dbConnections)
      .set({ status, error })
      .where(eq(dbConnections.id, id));
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const owned = await this.dbImpl
      .select({ id: dbConnections.id })
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.id, id)));
    if (!owned.length) return false;

    this.dbImpl.transaction((tx) => {
      // db_tables and db_columns cascade; the FTS mirror is virtual and has no
      // foreign keys, so it is cleared explicitly — same as chunks_fts.
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id = ${id}`);
      tx.delete(dbConnections).where(eq(dbConnections.id, id)).run();
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
    userId: string,
    tables: SnapshotTable[],
  ): Promise<void> {
    this.dbImpl.transaction((tx) => {
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id = ${connectionId}`);
      tx.delete(dbTables).where(eq(dbTables.connectionId, connectionId)).run();

      for (const t of tables) {
        const tableId = `${connectionId}:${t.schemaName}.${t.name}`;
        tx.insert(dbTables)
          .values({
            id: tableId,
            connectionId,
            userId,
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
              userId,
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
        .where(eq(dbConnections.id, connectionId))
        .run();
    });
  }

  /** Connection names and their table names — everything the system prompt needs. */
  async inventory(userId: string): Promise<ConnectionInventoryEntry[]> {
    const rows = (await this.dbImpl.all(sql`
      SELECT c.name AS connectionName, c.table_count AS tableCount,
             t.schema_name AS schemaName, t.name AS tableName
      FROM db_connections c
      LEFT JOIN db_tables t ON t.connection_id = c.id
      WHERE c.user_id = ${userId} AND c.status = 'connected'
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
    userId: string,
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
      WHERE c.user_id = ${userId} AND c.name = ${connectionName} AND c.status = 'connected'
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
    userId: string,
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
        AND c.user_id = ${userId}
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
