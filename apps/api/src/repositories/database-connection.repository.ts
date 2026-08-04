import { and, eq, sql } from "drizzle-orm";
import { db, dbConnections } from "../db/client";
import type { DbConnectionRow, DbConnectionStatus } from "../models/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

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

export interface DatabaseConnectionStore {
  create(conn: NewConnection): Promise<void>;
  list(userId: string): Promise<DbConnectionRow[]>;
  findByName(userId: string, name: string): Promise<DbConnectionRow | null>;
  resolveUrl(userId: string, connectionId: string): Promise<string | null>;
  markStatus(id: string, status: DbConnectionStatus, error: string | null): Promise<void>;
  remove(userId: string, id: string): Promise<boolean>;
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
