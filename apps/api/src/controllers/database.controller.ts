import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { closeStream, createEmitter, startHeartbeat } from "../lib/sse";
import {
  databaseConnectionStore,
  DuplicateConnectionNameError,
} from "../repositories/database-connection.repository";
import { introspectConnection } from "../services/db/introspect.service";
import { probe } from "../services/db/postgres.driver";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { currentUserId } from "../middleware/auth";

/**
 * The workspace this request applies to. `resolve` is the one place a
 * client-supplied workspace id is checked against ownership.
 */
const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

const newConnectionId = () =>
  `db_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Names reach the model, so they are constrained to something unambiguous. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/i;

/** GET /api/databases — a workspace's connections, newest first, never with a secret. */
export async function index(c: Context) {
  const connections = await databaseConnectionStore.list(await workspaceIdOf(c));
  return c.json({ connections });
}

/**
 * Everything `create` does up to and including writing the row: validate, probe,
 * insert. Shared by the JSON and streaming variants so the two cannot drift —
 * the only difference between them is how introspection is reported.
 */
type Prepared =
  | { ok: false; status: 400 | 409 | 503; error: string }
  | { ok: true; id: string; url: string; name: string; reachable: boolean };

async function prepareConnection(c: Context, workspaceId: string): Promise<Prepared> {
  if (!env.connectionSecret) {
    return {
      ok: false,
      status: 503,
      error: "CONNECTION_SECRET is not set — the API will not store a database credential",
    };
  }

  let body: { name?: string; url?: string };
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, status: 400, error: "Expected a JSON body" };
  }

  const name = String(body.name ?? "").trim();
  const url = String(body.url ?? "").trim();
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 400,
      error: "Name must be 1-31 letters, digits, hyphens or underscores",
    };
  }
  if (!url) return { ok: false, status: 400, error: "A connection URL is required" };

  if (await databaseConnectionStore.findByName(workspaceId, name)) {
    return { ok: false, status: 409, error: `A connection named "${name}" already exists` };
  }

  // Probed BEFORE the row is written, so the single insert below already
  // carries the correct status and error. Inserting "connected" and correcting
  // it afterward would leave a window where a concurrent GET sees the wrong
  // status for a connection that never worked.
  const reached = await probe(url);
  const id = newConnectionId();

  // Host and database come from the URL even when the probe failed, so a broken
  // connection is still identifiable in the list.
  let displayHost = "unknown";
  let displayDatabase = "unknown";
  try {
    const parsed = new URL(url);
    displayHost = parsed.hostname;
    displayDatabase = parsed.pathname.replace(/^\//, "") || "postgres";
  } catch {
    // probe() already reported this; the placeholders stand.
  }

  try {
    await databaseConnectionStore.create({
      id,
      workspaceId,
      name,
      url,
      displayHost,
      displayDatabase,
      status: reached.ok ? "connected" : "error",
      error: reached.ok ? null : reached.error,
    });
  } catch (e) {
    // The findByName check above is check-then-act: a second request for the
    // same name can race past it and hit the DB's unique index instead. That
    // must still surface as the same 409, not an unhandled 500.
    if (e instanceof DuplicateConnectionNameError) {
      return { ok: false, status: 409, error: e.message };
    }
    throw e;
  }

  if (!reached.ok) logger.warn("db.connect_failed", { id, name, error: reached.error });
  return { ok: true, id, url, name, reachable: reached.ok };
}

/** Re-read a row we just wrote. A miss should be impossible; say so if it happens. */
async function readBack(workspaceId: string, id: string) {
  return (await databaseConnectionStore.list(workspaceId)).find((r) => r.id === id) ?? null;
}

/**
 * POST /api/databases — add a connection, then introspect it.
 *
 * A database that cannot be reached is still stored, with the reason, so the
 * user can see and fix it. Only a genuinely invalid request is rejected outright.
 */
export async function create(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const prepared = await prepareConnection(c, workspaceId);
  if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);

  if (prepared.reachable) await introspectConnection(prepared.id, workspaceId, prepared.url);

  const connection = await readBack(workspaceId, prepared.id);
  if (!connection) return c.json({ error: "Connection was stored but could not be re-read" }, 500);
  return c.json({ connection }, 201);
}

/**
 * POST /api/databases/stream — the same thing, reporting each phase as it happens.
 *
 * Validation failures answer with plain JSON and their real status code, exactly
 * as `create` does; the stream only opens once there is genuinely work to watch.
 * That keeps a rejected request a normal HTTP error rather than a 200 whose body
 * has to be parsed to discover it failed.
 */
export async function createStreaming(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const prepared = await prepareConnection(c, workspaceId);
  if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);

  return streamSSE(c, async (stream) => {
    const emit = createEmitter(stream);
    const stopHeartbeat = startHeartbeat(stream);
    try {
      if (prepared.reachable) {
        emit({ type: "phase", phase: "connected", name: prepared.name });
        await introspectConnection(prepared.id, workspaceId, prepared.url, databaseConnectionStore, (p) =>
          emit({ type: "phase", ...p }),
        );
      }
      const connection = await readBack(workspaceId, prepared.id);
      emit({ type: "connection", connection });
    } catch (e: any) {
      // introspectConnection records its own failures, so reaching here means
      // something outside it broke; the client still needs to be told.
      emit({ type: "phase", phase: "failed", step: "attaching", error: e?.message ?? String(e) });
    } finally {
      stopHeartbeat();
      await closeStream(stream);
    }
  });
}

/** POST /api/databases/:id/refresh — re-introspect an existing connection. */
export async function refresh(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing connection id" }, 400);

  const url = await databaseConnectionStore.resolveUrl(workspaceId, id);
  if (!url) return c.json({ error: "Connection not found" }, 404);

  await introspectConnection(id, workspaceId, url);
  const connection = (await databaseConnectionStore.list(workspaceId)).find((r) => r.id === id);
  return c.json({ connection });
}

/** DELETE /api/databases/:id — removes the snapshot and its search index too. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing connection id" }, 400);

  const removed = await databaseConnectionStore.remove(await workspaceIdOf(c), id);
  if (!removed) return c.json({ error: "Connection not found" }, 404);
  return c.body(null, 204);
}
