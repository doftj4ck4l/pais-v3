import { and, eq, sql } from "drizzle-orm";
import { db, mcpServers, mcpCapabilities } from "../db/client";
import type {
  McpCapabilityKind,
  McpCapabilityRow,
  McpServerRow,
  McpServerStatus,
  McpTransport,
} from "../models/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

/**
 * The only thing that touches `mcp_servers` and `mcp_capabilities`.
 *
 * `list` selects an explicit column set rather than `select()`. The encrypted
 * header and env blobs must never leave this module by accident, and an
 * explicit list is the only way that stays true when the table gains a field.
 * `resolveSecrets` is the single door out, and it checks ownership first.
 */

export type NewMcpServer = {
  id: string;
  workspaceId: string;
  name: string;
  transport: McpTransport;
  /** http only */
  url?: string;
  /** http only — stored encrypted */
  headers?: Record<string, string>;
  /** stdio only */
  command?: string;
  /** stdio only */
  args?: string[];
  /** stdio only — stored encrypted */
  env?: Record<string, string>;
  enabled?: boolean;
  // Lets a caller that already probed the server store the row as
  // already-correct, rather than inserting "connected" and immediately
  // correcting it — the gap between those two writes is visible to a
  // concurrent read.
  status?: McpServerStatus;
  error?: string | null;
};

export type NewCapability = {
  kind: McpCapabilityKind;
  name: string;
  description?: string | null;
  schemaJson?: string | null;
  uri?: string | null;
};

export type McpInventoryEntry = {
  name: string;
  transport: McpTransport;
  tools: { name: string; description: string | null }[];
};

/**
 * Thrown by `create()` when the unique index on (workspace_id, name) is hit by
 * a request that slipped past the caller's own pre-check — two inserts for the
 * same name racing each other. Lets the controller map the race to the same 409
 * the pre-check returns, instead of a bare 500.
 */
export class DuplicateServerNameError extends Error {
  constructor(public readonly serverName: string) {
    super(`An MCP server named "${serverName}" already exists`);
    this.name = "DuplicateServerNameError";
  }
}

/**
 * bun:sqlite reports a violated UNIQUE index via `error.code`, not by message
 * text alone. The message check narrows this to the (workspace_id, name) index
 * specifically, so an id collision is not misreported as a duplicate name.
 */
function isDuplicateNameViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    e.message.includes("mcp_servers.name")
  );
}

/**
 * Encrypt a credential map, or store nothing when there is nothing to store.
 * An empty object would otherwise round-trip as a ciphertext blob that decrypts
 * to `{}` — indistinguishable, at a glance, from a real secret.
 */
function encryptMap(map: Record<string, string> | undefined): string | null {
  if (!map || Object.keys(map).length === 0) return null;
  return encryptSecret(JSON.stringify(map));
}

/**
 * Decrypt a credential map. A blob that fails to decrypt or parse yields `{}`
 * rather than throwing: a server whose secret was written under a different
 * `CONNECTION_SECRET` should fail its own connection attempt with a clear
 * transport error, not take down the whole run at resolve time.
 */
function decryptMap(payload: string | null): Record<string, string> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(decryptSecret(payload));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export interface McpStore {
  create(server: NewMcpServer): Promise<void>;
  list(workspaceId: string): Promise<McpServerRow[]>;
  listEnabled(workspaceId: string): Promise<McpServerRow[]>;
  findByName(workspaceId: string, name: string): Promise<McpServerRow | null>;
  resolveSecrets(
    workspaceId: string,
    id: string,
  ): Promise<{ headers: Record<string, string>; env: Record<string, string> } | null>;
  setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<void>;
  markStatus(
    workspaceId: string,
    id: string,
    status: McpServerStatus,
    error: string | null,
  ): Promise<void>;
  saveCapabilities(
    workspaceId: string,
    serverId: string,
    caps: NewCapability[],
  ): Promise<void>;
  capabilities(
    workspaceId: string,
    serverId?: string,
    kind?: McpCapabilityKind,
  ): Promise<McpCapabilityRow[]>;
  inventory(workspaceId: string): Promise<McpInventoryEntry[]>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

/** Everything except `headers_enc` and `env_enc`. */
const PUBLIC_COLUMNS = {
  id: mcpServers.id,
  workspaceId: mcpServers.workspaceId,
  name: mcpServers.name,
  transport: mcpServers.transport,
  url: mcpServers.url,
  command: mcpServers.command,
  argsJson: mcpServers.argsJson,
  enabled: mcpServers.enabled,
  status: mcpServers.status,
  error: mcpServers.error,
  toolCount: mcpServers.toolCount,
  lastProbedAt: mcpServers.lastProbedAt,
  createdAt: mcpServers.createdAt,
};

export class SqliteMcpStore implements McpStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(server: NewMcpServer): Promise<void> {
    try {
      await this.dbImpl.insert(mcpServers).values({
        id: server.id,
        workspaceId: server.workspaceId,
        name: server.name,
        transport: server.transport,
        url: server.url ?? null,
        headersEnc: encryptMap(server.headers),
        command: server.command ?? null,
        argsJson: server.args ? JSON.stringify(server.args) : null,
        envEnc: encryptMap(server.env),
        enabled: server.enabled === false ? 0 : 1,
        status: server.status ?? "connected",
        error: server.error ?? null,
        toolCount: 0,
        lastProbedAt: null,
        createdAt: Date.now(),
      });
    } catch (e) {
      if (isDuplicateNameViolation(e)) throw new DuplicateServerNameError(server.name);
      throw e;
    }
  }

  async list(workspaceId: string): Promise<McpServerRow[]> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(mcpServers)
      .where(eq(mcpServers.workspaceId, workspaceId))
      .orderBy(sql`created_at desc`);
    return rows as McpServerRow[];
  }

  async listEnabled(workspaceId: string): Promise<McpServerRow[]> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.enabled, 1)))
      .orderBy(sql`created_at desc`);
    return rows as McpServerRow[];
  }

  async findByName(workspaceId: string, name: string): Promise<McpServerRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.name, name)));
    return (rows[0] as McpServerRow) ?? null;
  }

  /** Decrypts only after confirming the caller owns the row. */
  async resolveSecrets(
    workspaceId: string,
    id: string,
  ): Promise<{ headers: Record<string, string>; env: Record<string, string> } | null> {
    const rows = await this.dbImpl
      .select({ headersEnc: mcpServers.headersEnc, envEnc: mcpServers.envEnc })
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
    const row = rows[0];
    if (!row) return null;
    return { headers: decryptMap(row.headersEnc), env: decryptMap(row.envEnc) };
  }

  async setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<void> {
    await this.dbImpl
      .update(mcpServers)
      .set({ enabled: enabled ? 1 : 0 })
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
  }

  async markStatus(
    workspaceId: string,
    id: string,
    status: McpServerStatus,
    error: string | null,
  ): Promise<void> {
    await this.dbImpl
      .update(mcpServers)
      .set({ status, error })
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
  }

  /**
   * Replace everything a server advertised, in one transaction.
   *
   * Replace rather than merge: a tool the server has dropped must disappear
   * from the agent's tool list, and a merge would keep offering it forever.
   */
  async saveCapabilities(
    workspaceId: string,
    serverId: string,
    caps: NewCapability[],
  ): Promise<void> {
    const owned = await this.dbImpl
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, serverId)));
    if (!owned.length) return;

    const toolCount = caps.filter((c) => c.kind === "tool").length;
    const probedAt = Date.now();

    this.dbImpl.transaction((tx) => {
      tx.delete(mcpCapabilities).where(eq(mcpCapabilities.serverId, serverId)).run();
      for (const [i, cap] of caps.entries()) {
        tx.insert(mcpCapabilities)
          .values({
            id: `${serverId}:${cap.kind}:${i}`,
            serverId,
            workspaceId,
            kind: cap.kind,
            name: cap.name,
            description: cap.description ?? null,
            schemaJson: cap.schemaJson ?? null,
            uri: cap.uri ?? null,
          })
          .run();
      }
      tx.update(mcpServers)
        .set({ toolCount, lastProbedAt: probedAt })
        .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, serverId)))
        .run();
    });
  }

  async capabilities(
    workspaceId: string,
    serverId?: string,
    kind?: McpCapabilityKind,
  ): Promise<McpCapabilityRow[]> {
    const filters = [eq(mcpCapabilities.workspaceId, workspaceId)];
    if (serverId) filters.push(eq(mcpCapabilities.serverId, serverId));
    if (kind) filters.push(eq(mcpCapabilities.kind, kind));
    const rows = await this.dbImpl
      .select()
      .from(mcpCapabilities)
      .where(and(...filters));
    return rows as McpCapabilityRow[];
  }

  /**
   * What the system prompt needs: every enabled server and the tools it offers,
   * read from the cache so building a prompt never opens a socket.
   */
  async inventory(workspaceId: string): Promise<McpInventoryEntry[]> {
    const servers = await this.listEnabled(workspaceId);
    if (!servers.length) return [];
    const caps = await this.capabilities(workspaceId, undefined, "tool");

    const byServer = new Map<string, { name: string; description: string | null }[]>();
    for (const cap of caps) {
      const list = byServer.get(cap.serverId) ?? [];
      list.push({ name: cap.name, description: cap.description });
      byServer.set(cap.serverId, list);
    }

    return servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      tools: byServer.get(s.id) ?? [],
    }));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const owned = await this.dbImpl
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
    if (!owned.length) return false;

    // mcp_capabilities cascades on the foreign key, so deleting the server is
    // enough. Scoped by workspaceId anyway, consistent with every other write
    // here: a future caller that skips the pre-check gets a no-op rather than
    // touching someone else's row.
    await this.dbImpl
      .delete(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, id)));
    return true;
  }

  /** Test-only: proves the credential columns hold ciphertext, not plaintext. */
  async debugRawSecrets(id: string): Promise<{
    headersEnc: string | null;
    envEnc: string | null;
  }> {
    const rows = await this.dbImpl
      .select({ headersEnc: mcpServers.headersEnc, envEnc: mcpServers.envEnc })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    return { headersEnc: rows[0]?.headersEnc ?? null, envEnc: rows[0]?.envEnc ?? null };
  }
}

export const mcpStore: McpStore = new SqliteMcpStore();
