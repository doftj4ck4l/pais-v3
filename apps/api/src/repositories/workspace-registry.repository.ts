import { and, eq, sql } from "drizzle-orm";
import { db, users, workspaces } from "../db/client";
import type { WorkspaceRow } from "../db/client";

const genId = () =>
  `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Scoped tables, in an order that clears children before their parents. */
const SCOPED_TABLES = [
  "documents",
  "chunks",
  "db_columns",
  "db_tables",
  "db_connections",
  "memory_notes",
  "conversations",
  "sandboxes",
] as const;

export interface WorkspaceRegistry {
  create(userId: string, name: string): Promise<WorkspaceRow>;
  list(userId: string): Promise<WorkspaceRow[]>;
  getOwned(id: string, userId: string): Promise<WorkspaceRow | undefined>;
  rename(id: string, userId: string, name: string): Promise<boolean>;
  remove(id: string, userId: string): Promise<boolean>;
  resolve(userId: string, requested?: string): Promise<WorkspaceRow>;
}

/**
 * Workspaces and the rule for picking one.
 *
 * Ownership is checked here rather than by callers, because every scoped query
 * downstream trusts the workspace id it is handed. If a forged id could get
 * past this module, it would reach documents, connections and transcripts.
 */
export class SqliteWorkspaceRegistry implements WorkspaceRegistry {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(userId: string, name: string): Promise<WorkspaceRow> {
    // Workspaces are now the only thing a user directly owns, so this is where
    // the user row gets written. Nothing else creates one.
    await this.dbImpl
      .insert(users)
      .values({ id: userId, createdAt: Date.now() })
      .onConflictDoNothing();

    const row: WorkspaceRow = {
      id: genId(),
      userId,
      name: name.trim() || "Untitled",
      createdAt: Date.now(),
    };
    await this.dbImpl.insert(workspaces).values(row);
    return row;
  }

  async list(userId: string): Promise<WorkspaceRow[]> {
    return (await this.dbImpl
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, userId))
      .orderBy(workspaces.createdAt, workspaces.id)) as WorkspaceRow[];
  }

  async getOwned(id: string, userId: string): Promise<WorkspaceRow | undefined> {
    const rows = await this.dbImpl
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
      .limit(1);
    return rows[0] as WorkspaceRow | undefined;
  }

  async rename(id: string, userId: string, name: string): Promise<boolean> {
    if (!(await this.getOwned(id, userId))) return false;
    await this.dbImpl
      .update(workspaces)
      .set({ name: name.trim() || "Untitled" })
      .where(eq(workspaces.id, id));
    return true;
  }

  async remove(id: string, userId: string): Promise<boolean> {
    if (!(await this.getOwned(id, userId))) return false;
    // A user always needs somewhere for the next run to go, and removing the
    // last one would strand every row the backfill would then re-orphan.
    if ((await this.list(userId)).length <= 1) return false;

    // Scoped tables have no foreign key to workspaces, so removing the row
    // alone would leave documents, conversations and connections unreachable
    // but still present — invisible rows that still match a search. They are
    // deleted explicitly, in one transaction with the workspace.
    this.dbImpl.transaction((tx) => {
      // The FTS mirrors go first, while the rows naming them still exist.
      // Both are FTS5 virtual tables: they carry no foreign keys, so nothing
      // cascades into them and a stale row would keep answering searches for a
      // workspace that is gone. Neither has a workspace_id of its own, so each
      // is reached through the table it mirrors.
      tx.run(sql`DELETE FROM chunks_fts WHERE document_id IN
                   (SELECT id FROM documents WHERE workspace_id = ${id})`);
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id IN
                   (SELECT id FROM db_connections WHERE workspace_id = ${id})`);

      // Transcript rows hang off conversations rather than the workspace.
      // They would cascade, but only where the connection has foreign keys
      // switched on — which is true of the app's handle and not of a bare
      // test database, so they are cleared explicitly.
      for (const table of ["messages", "traces"]) {
        tx.run(
          sql`DELETE FROM ${sql.raw(table)} WHERE conversation_id IN
                (SELECT id FROM conversations WHERE workspace_id = ${id})`,
        );
      }

      for (const table of SCOPED_TABLES) {
        tx.run(sql`DELETE FROM ${sql.raw(table)} WHERE workspace_id = ${id}`);
      }
      tx.delete(workspaces).where(eq(workspaces.id, id)).run();
    });
    return true;
  }

  /**
   * The workspace a request applies to. An unknown or unowned id falls back to
   * the user's first workspace rather than erroring — a client may hold an id
   * that was deleted in another tab.
   */
  async resolve(userId: string, requested?: string): Promise<WorkspaceRow> {
    if (requested) {
      const owned = await this.getOwned(requested, userId);
      if (owned) return owned;
    }
    const existing = await this.list(userId);
    return existing[0] ?? (await this.create(userId, "Default"));
  }
}

export const workspaceRegistry: WorkspaceRegistry = new SqliteWorkspaceRegistry();
