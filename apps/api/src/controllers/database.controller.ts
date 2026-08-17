import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { env } from "../config/env";
import { closeStream, createEmitter, startHeartbeat } from "../lib/sse";
import { logger } from "../lib/logger";
import { currentUserId } from "../middleware/auth";
import {
  databaseConnectionStore,
  DuplicateConnectionNameError,
} from "../repositories/database-connection.repository";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import type {
  DatabaseConnectionConfig,
  DatabaseError,
  DatabaseErrorCode,
  DatabaseSslMode,
} from "../services/db/database-adapter";
import {
  databaseAdapterRegistry,
  databaseConnector,
} from "../services/db/database-connector.service";
import { introspectConnection } from "../services/db/introspect.service";

const workspaceIdOf = async (c: Context) => {
  const workspace = await workspaceRegistry.resolve(currentUserId(c), c.req.query("workspaceId"));
  return workspace.id;
};

const newConnectionId = () =>
  `db_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
const apiError = (error: DatabaseError) => ({ error });
const requestError = (message: string, field?: string): DatabaseError => ({
  code: "invalid_configuration",
  message,
  ...(field ? { field } : {}),
});

type ConnectionBody = {
  name?: unknown;
  engine?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  username?: unknown;
  password?: unknown;
  ssl?: { mode?: unknown; ca?: unknown; serverName?: unknown };
};

async function readBody(c: Context): Promise<{ ok: true; body: ConnectionBody } | { ok: false; error: DatabaseError }> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, error: requestError("Expected a JSON object") };
    }
    return { ok: true, body: body as ConnectionBody };
  } catch {
    return { ok: false, error: requestError("Expected a JSON body") };
  }
}

function parseConfig(
  body: ConnectionBody,
  existing?: DatabaseConnectionConfig,
): { ok: true; name: string; config: DatabaseConnectionConfig } | { ok: false; error: DatabaseError } {
  const name = String(body.name ?? "").trim();
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: requestError("Name must be 1-31 letters, digits, hyphens or underscores", "name") };
  }

  const engine = String(body.engine ?? existing?.engine ?? "postgresql").trim();
  const adapter = databaseAdapterRegistry.get(engine);
  const host = String(body.host ?? existing?.host ?? "").trim();
  const database = String(body.database ?? existing?.database ?? "").trim();
  const username = String(body.username ?? existing?.username ?? "").trim();
  const password = body.password === undefined ? existing?.password ?? "" : String(body.password);
  const port = Number(body.port ?? existing?.port ?? adapter?.defaultPort ?? 0);
  const mode = String(body.ssl?.mode ?? existing?.ssl.mode ?? "disable") as DatabaseSslMode;

  if (adapter && !adapter.capabilities.sslModes.includes(mode)) {
    return { ok: false, error: requestError("SSL mode must be disable, require, or verify-full", "ssl.mode") };
  }
  const ca = body.ssl?.ca === undefined
    ? existing?.ssl.ca ?? null
    : body.ssl.ca === null || body.ssl.ca === ""
      ? null
      : String(body.ssl.ca);
  const serverName = body.ssl?.serverName === undefined
    ? existing?.ssl.serverName ?? null
    : body.ssl.serverName === null || body.ssl.serverName === ""
      ? null
      : String(body.ssl.serverName).trim();

  const config: DatabaseConnectionConfig = {
    engine,
    host,
    port,
    database,
    username,
    password,
    ssl: { mode, ca, serverName },
  };
  const invalid = databaseConnector.validate(config);
  return invalid ? { ok: false, error: invalid } : { ok: true, name, config };
}

const INVALID_ATTEMPT_CODES = new Set<DatabaseErrorCode>([
  "invalid_configuration",
  "unsupported_engine",
  "target_not_allowed",
  "dns_resolution_failed",
]);

function invalidAttempt(error: DatabaseError): boolean {
  return INVALID_ATTEMPT_CODES.has(error.code);
}

/** GET /api/databases — public fields only; no password, CA, or URL exists here. */
export async function index(c: Context) {
  return c.json({ connections: await databaseConnectionStore.list(await workspaceIdOf(c)) });
}

type Prepared =
  | { ok: false; status: 400 | 409 | 503; error: DatabaseError }
  | {
      ok: true;
      id: string;
      name: string;
      config: DatabaseConnectionConfig;
      reachable: boolean;
    };

async function prepareConnection(c: Context, workspaceId: string): Promise<Prepared> {
  if (!env.connectionSecret) {
    return {
      ok: false,
      status: 503,
      error: requestError("CONNECTION_SECRET is not set — the API will not store a database credential"),
    };
  }
  const input = await readBody(c);
  if (!input.ok) return { ok: false, status: 400, error: input.error };
  const parsed = parseConfig(input.body);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  if (await databaseConnectionStore.findByName(workspaceId, parsed.name)) {
    return {
      ok: false,
      status: 409,
      error: requestError(`A connection named "${parsed.name}" already exists`, "name"),
    };
  }

  const reached = await databaseConnector.testConnection(parsed.config);
  if (!reached.ok && invalidAttempt(reached.error)) {
    return { ok: false, status: 400, error: reached.error };
  }

  const id = newConnectionId();
  const connectionError = reached.ok ? null : reached.error.message;
  try {
    await databaseConnectionStore.create({
      id,
      workspaceId,
      name: parsed.name,
      config: parsed.config,
      status: reached.ok ? "connected" : "error",
      error: connectionError,
    });
  } catch (error) {
    if (error instanceof DuplicateConnectionNameError) {
      return { ok: false, status: 409, error: requestError(error.message, "name") };
    }
    throw error;
  }

  if (!reached.ok) {
    logger.warn("db.connect_failed", { connectionId: id, name: parsed.name, code: reached.error.code });
  }
  return {
    ok: true,
    id,
    name: parsed.name,
    config: parsed.config,
    reachable: reached.ok,
  };
}

async function readBack(workspaceId: string, id: string) {
  return databaseConnectionStore.findById(workspaceId, id);
}

function sameConnectionConfig(a: DatabaseConnectionConfig, b: DatabaseConnectionConfig): boolean {
  return (
    a.engine === b.engine &&
    a.host === b.host &&
    a.port === b.port &&
    a.database === b.database &&
    a.username === b.username &&
    a.password === b.password &&
    a.ssl.mode === b.ssl.mode &&
    (a.ssl.ca ?? null) === (b.ssl.ca ?? null) &&
    (a.ssl.serverName ?? null) === (b.ssl.serverName ?? null)
  );
}

export async function create(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const prepared = await prepareConnection(c, workspaceId);
  if (!prepared.ok) return c.json(apiError(prepared.error), prepared.status);

  if (prepared.reachable) {
    await introspectConnection(prepared.id, workspaceId, prepared.config);
  }
  const connection = await readBack(workspaceId, prepared.id);
  if (!connection) return c.json(apiError(requestError("Connection was stored but could not be re-read")), 500);
  return c.json({ connection }, 201);
}

export async function createStreaming(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const prepared = await prepareConnection(c, workspaceId);
  if (!prepared.ok) return c.json(apiError(prepared.error), prepared.status);

  return streamSSE(c, async (stream) => {
    const emit = createEmitter(stream);
    const stopHeartbeat = startHeartbeat(stream);
    try {
      if (prepared.reachable) {
        emit({ type: "phase", phase: "connected", name: prepared.name });
        await introspectConnection(
          prepared.id,
          workspaceId,
          prepared.config,
          {
            store: databaseConnectionStore,
            onPhase: (phase) => emit({ type: "phase", ...phase }),
          },
        );
      }
      emit({ type: "connection", connection: await readBack(workspaceId, prepared.id) });
    } catch {
      emit({
        type: "phase",
        phase: "failed",
        step: "attaching",
        error: "The connection was stored, but schema discovery failed",
      });
    } finally {
      stopHeartbeat();
      await closeStream(stream);
    }
  });
}

/** Test submitted settings without persisting them. */
export async function testConnection(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  void workspaceId; // ownership resolution is the authorization gate
  const input = await readBody(c);
  if (!input.ok) return c.json(apiError(input.error), 400);
  const parsed = parseConfig(input.body);
  if (!parsed.ok) return c.json(apiError(parsed.error), 400);
  const result = await databaseConnector.testConnection(parsed.config);
  if (!result.ok && invalidAttempt(result.error)) return c.json(apiError(result.error), 400);
  return c.json(result);
}

/** Test an existing owned connection without mutating its status or snapshot. */
export async function testStoredConnection(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const config = await databaseConnectionStore.resolveConfig(workspaceId, c.req.param("id") ?? "");
  if (!config) return c.json(apiError(requestError("Connection not found")), 404);
  return c.json(await databaseConnector.testConnection(config));
}

/** PATCH /api/databases/:id — replace settings, preserving omitted secrets. */
export async function update(c: Context) {
  if (!env.connectionSecret) {
    return c.json(apiError(requestError("CONNECTION_SECRET is not set — the API will not store a database credential")), 503);
  }
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id") ?? "";
  const existing = await databaseConnectionStore.resolveConnection(workspaceId, id);
  if (!existing) return c.json(apiError(requestError("Connection not found")), 404);
  const { config: existingConfig, row: existingRow } = existing;

  const input = await readBody(c);
  if (!input.ok) return c.json(apiError(input.error), 400);
  const parsed = parseConfig({ ...input.body, name: input.body.name ?? existingRow.name }, existingConfig);
  if (!parsed.ok) return c.json(apiError(parsed.error), 400);

  if (parsed.name !== existingRow.name) {
    const duplicate = await databaseConnectionStore.findByName(workspaceId, parsed.name);
    if (duplicate && duplicate.id !== id) {
      return c.json(apiError(requestError(`A connection named "${parsed.name}" already exists`, "name")), 409);
    }
  }

  const configChanged = !sameConnectionConfig(existingConfig, parsed.config);
  if (!configChanged && parsed.name === existingRow.name) {
    return c.json({ connection: existingRow });
  }

  const reached = configChanged
    ? await databaseConnector.testConnection(parsed.config)
    : { ok: true as const, value: { latencyMs: 0 } };
  if (!reached.ok && invalidAttempt(reached.error)) return c.json(apiError(reached.error), 400);
  try {
    const updated = await databaseConnectionStore.update(workspaceId, id, {
      name: parsed.name,
      config: parsed.config,
      status: configChanged ? (reached.ok ? "connected" : "error") : existingRow.status,
      error: configChanged ? (reached.ok ? null : reached.error.message) : existingRow.error,
    });
    if (!updated) return c.json(apiError(requestError("Connection not found")), 404);
  } catch (error) {
    if (error instanceof DuplicateConnectionNameError) {
      return c.json(apiError(requestError(error.message, "name")), 409);
    }
    throw error;
  }
  if (configChanged && reached.ok) await introspectConnection(id, workspaceId, parsed.config);
  return c.json({ connection: await readBack(workspaceId, id) });
}

export async function refresh(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id") ?? "";
  const config = await databaseConnectionStore.resolveConfig(workspaceId, id);
  if (!config) return c.json(apiError(requestError("Connection not found")), 404);
  await introspectConnection(id, workspaceId, config);
  return c.json({ connection: await readBack(workspaceId, id) });
}

export async function destroy(c: Context) {
  const id = c.req.param("id") ?? "";
  if (!id) return c.json(apiError(requestError("Missing connection id")), 400);
  if (!(await databaseConnectionStore.remove(await workspaceIdOf(c), id))) {
    return c.json(apiError(requestError("Connection not found")), 404);
  }
  return c.body(null, 204);
}
