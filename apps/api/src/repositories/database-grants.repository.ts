import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, databaseGrants, dbConnections } from "../db/client";

/**
 * The only thing that touches `database_grants`.
 *
 * A grant names a connection that the workers in one organization ("department")
 * may use. It stores the *connection id* — the owning workspace keeps the
 * secret and the snapshot — so revoking is deleting one row and credentials are
 * never copied per member. Reads on `db_connections` become grant-aware inside
 * `database-connection.repository`, which is the single enforcement point.
 */

export interface DatabaseGrantStore {
  /**
   * Replace the granted set for one organization with exactly `connectionIds`.
   * Idempotent (the unique index makes re-insertion a no-op by skipping rows
   * already present); unused grants are removed so the set never drifts.
   * Callers validate that every id is a connection the granter actually owns.
   */
  setGrants(
    organizationId: string,
    connectionIds: string[],
    grantedByUserId: string,
    now: number,
  ): Promise<void>;
  listGrantedConnectionIds(organizationId: string): Promise<string[]>;
  /**
   * Every connection id reachable through this workspace: the ids granted to
   * each organization its owner belongs to. This is what the database store's
   * read paths union with the workspace's own connections.
   */
  grantedConnectionIdsForWorkspace(workspaceId: string): Promise<string[]>;
  /** The connection ids in workspaces a user owns. */
  connectionsOwnedByUser(userId: string): Promise<string[]>;
}

export class SqliteDatabaseGrantStore implements DatabaseGrantStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async setGrants(
    organizationId: string,
    connectionIds: string[],
    grantedByUserId: string,
    now: number,
  ): Promise<void> {
    const existing = await this.listGrantedConnectionIds(organizationId);
    const existingSet = new Set(existing);
    const desired = new Set(connectionIds);

    this.dbImpl.transaction((tx) => {
      const toRemove = [...existing].filter((id) => !desired.has(id));
      if (toRemove.length) {
        tx.delete(databaseGrants)
          .where(
            and(
              eq(databaseGrants.organizationId, organizationId),
              inArray(databaseGrants.connectionId, toRemove),
            ),
          )
          .run();
      }
      for (const connectionId of connectionIds) {
        if (existingSet.has(connectionId)) continue;
        tx.insert(databaseGrants)
          .values({
            id: `datagrant_${randomUUID()}`,
            organizationId,
            connectionId,
            grantedByUserId,
            createdAt: now,
          })
          .run();
      }
    });
  }

  async listGrantedConnectionIds(organizationId: string): Promise<string[]> {
    const rows = await this.dbImpl
      .select({ connectionId: databaseGrants.connectionId })
      .from(databaseGrants)
      .where(eq(databaseGrants.organizationId, organizationId));
    return rows.map((r) => r.connectionId);
  }

  async grantedConnectionIdsForWorkspace(workspaceId: string): Promise<string[]> {
    const rows = (await this.dbImpl.all(sql`
      SELECT DISTINCT dg.connection_id AS id
      FROM database_grants dg
      JOIN organization_memberships om ON om.organization_id = dg.organization_id
      JOIN workspaces ws ON ws.user_id = om.user_id
      WHERE ws.id = ${workspaceId}
    `)) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async connectionsOwnedByUser(userId: string): Promise<string[]> {
    const rows = (await this.dbImpl.all(sql`
      SELECT c.id AS id
      FROM db_connections c
      JOIN workspaces ws ON ws.id = c.workspace_id
      WHERE ws.user_id = ${userId}
    `)) as { id: string }[];
    return rows.map((r) => r.id);
  }
}

export const databaseGrantStore: DatabaseGrantStore = new SqliteDatabaseGrantStore();
