import { and, desc, eq } from "drizzle-orm";
import { db, connectors } from "../db/client";
import type { ConnectorKind, ConnectorRow, ConnectorStatus } from "../models/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

/**
 * The only thing that touches `connectors`.
 *
 * OAuth tokens follow the same rule as database connection strings and MCP
 * server secrets: encrypted at rest, and selected only by the one method that
 * needs them. Every other read goes through `PUBLIC_COLUMNS`, so a field added
 * later cannot leak by being included in a `select()`.
 */

export type OAuthTokens = {
  accessToken: string;
  /**
   * Absent when the provider declined to issue one — Google only returns a
   * refresh token on the first consent, which is why the auth URL asks for
   * `prompt=consent` every time.
   */
  refreshToken?: string;
  /** Epoch ms. Refreshed slightly early rather than on expiry. */
  expiresAt: number;
};

export type NewConnector = {
  id: string;
  workspaceId: string;
  kind: ConnectorKind;
  accountEmail: string | null;
  tokens: OAuthTokens;
};

/** Everything except `tokens_enc`. */
const PUBLIC_COLUMNS = {
  id: connectors.id,
  workspaceId: connectors.workspaceId,
  kind: connectors.kind,
  accountEmail: connectors.accountEmail,
  status: connectors.status,
  error: connectors.error,
  cursor: connectors.cursor,
  lastSyncAt: connectors.lastSyncAt,
  createdAt: connectors.createdAt,
};

export interface ConnectorStore {
  create(connector: NewConnector): Promise<void>;
  list(workspaceId: string): Promise<ConnectorRow[]>;
  get(workspaceId: string, id: string): Promise<ConnectorRow | null>;
  findByAccount(
    workspaceId: string,
    kind: ConnectorKind,
    accountEmail: string,
  ): Promise<ConnectorRow | null>;
  tokens(workspaceId: string, id: string): Promise<OAuthTokens | null>;
  saveTokens(workspaceId: string, id: string, tokens: OAuthTokens): Promise<void>;
  markStatus(
    workspaceId: string,
    id: string,
    status: ConnectorStatus,
    error: string | null,
  ): Promise<void>;
  saveCursor(workspaceId: string, id: string, cursor: string | null): Promise<void>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export class SqliteConnectorStore implements ConnectorStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(connector: NewConnector): Promise<void> {
    await this.dbImpl.insert(connectors).values({
      id: connector.id,
      workspaceId: connector.workspaceId,
      kind: connector.kind,
      accountEmail: connector.accountEmail,
      status: "connected",
      error: null,
      tokensEnc: encryptSecret(JSON.stringify(connector.tokens)),
      cursor: null,
      lastSyncAt: null,
      createdAt: Date.now(),
    });
  }

  async list(workspaceId: string): Promise<ConnectorRow[]> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(connectors)
      .where(eq(connectors.workspaceId, workspaceId))
      .orderBy(desc(connectors.createdAt));
    return rows as ConnectorRow[];
  }

  async get(workspaceId: string, id: string): Promise<ConnectorRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
    return (rows[0] as ConnectorRow) ?? null;
  }

  /**
   * Re-authorising the same account updates the existing row instead of adding
   * a second one. Two connectors for one Drive would sync every file twice.
   */
  async findByAccount(
    workspaceId: string,
    kind: ConnectorKind,
    accountEmail: string,
  ): Promise<ConnectorRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(connectors)
      .where(
        and(
          eq(connectors.workspaceId, workspaceId),
          eq(connectors.kind, kind),
          eq(connectors.accountEmail, accountEmail),
        ),
      );
    return (rows[0] as ConnectorRow) ?? null;
  }

  async tokens(workspaceId: string, id: string): Promise<OAuthTokens | null> {
    const rows = await this.dbImpl
      .select({ tokensEnc: connectors.tokensEnc })
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
    const payload = rows[0]?.tokensEnc;
    if (!payload) return null;
    try {
      return JSON.parse(decryptSecret(payload)) as OAuthTokens;
    } catch {
      // A row encrypted with a different CONNECTION_SECRET is unreadable, not
      // recoverable. Reported as "not connected" so the fix is to reconnect.
      return null;
    }
  }

  async saveTokens(workspaceId: string, id: string, tokens: OAuthTokens): Promise<void> {
    await this.dbImpl
      .update(connectors)
      .set({ tokensEnc: encryptSecret(JSON.stringify(tokens)) })
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
  }

  async markStatus(
    workspaceId: string,
    id: string,
    status: ConnectorStatus,
    error: string | null,
  ): Promise<void> {
    await this.dbImpl
      .update(connectors)
      .set({
        status,
        error,
        // Stamped on any terminal status, so "last attempted" is visible even
        // when the attempt failed. A sync that has never succeeded and one that
        // failed an hour ago are different problems.
        ...(status === "syncing" ? {} : { lastSyncAt: Date.now() }),
      })
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
  }

  async saveCursor(workspaceId: string, id: string, cursor: string | null): Promise<void> {
    await this.dbImpl
      .update(connectors)
      .set({ cursor })
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const owned = await this.dbImpl
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
    if (!owned.length) return false;
    await this.dbImpl.delete(connectors).where(eq(connectors.id, id));
    return true;
  }
}

export const connectorStore: ConnectorStore = new SqliteConnectorStore();
