import type { Context } from "hono";
import {
  databaseConnectionStore,
  DuplicateConnectionNameError,
} from "../repositories/database-connection.repository";
import { introspectConnection } from "../services/db/introspect.service";
import { probe } from "../services/db/postgres.driver";
import { env } from "../config/env";
import { logger } from "../lib/logger";

const userIdOf = (c: Context) => c.req.query("userId") ?? env.defaultUserId;

const newConnectionId = () =>
  `db_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Names reach the model, so they are constrained to something unambiguous. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/i;

/** GET /api/databases — a user's connections, newest first, never with a secret. */
export async function index(c: Context) {
  const connections = await databaseConnectionStore.list(userIdOf(c));
  return c.json({ connections });
}

/**
 * POST /api/databases — add a connection, then introspect it.
 *
 * A database that cannot be reached is still stored, with the reason, so the
 * user can see and fix it. Only a genuinely invalid request is rejected outright.
 */
export async function create(c: Context) {
  const userId = userIdOf(c);

  if (!env.connectionSecret) {
    return c.json(
      { error: "CONNECTION_SECRET is not set — the API will not store a database credential" },
      503,
    );
  }

  let body: { name?: string; url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const name = String(body.name ?? "").trim();
  const url = String(body.url ?? "").trim();
  if (!NAME_PATTERN.test(name)) {
    return c.json({ error: "Name must be 1-31 letters, digits, hyphens or underscores" }, 400);
  }
  if (!url) return c.json({ error: "A connection URL is required" }, 400);

  if (await databaseConnectionStore.findByName(userId, name)) {
    return c.json({ error: `A connection named "${name}" already exists` }, 409);
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
      userId,
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
      return c.json({ error: e.message }, 409);
    }
    throw e;
  }

  if (!reached.ok) {
    logger.warn("db.connect_failed", { id, name, error: reached.error });
    const connection = (await databaseConnectionStore.list(userId)).find((r) => r.id === id);
    // Re-reading the row we just wrote should never miss; if it does, saying so
    // beats silently returning an undefined body.
    if (!connection) return c.json({ error: "Connection was stored but could not be re-read" }, 500);
    return c.json({ connection }, 201);
  }

  await introspectConnection(id, userId, url);
  const connection = (await databaseConnectionStore.list(userId)).find((r) => r.id === id);
  if (!connection) return c.json({ error: "Connection was stored but could not be re-read" }, 500);
  return c.json({ connection }, 201);
}

/** POST /api/databases/:id/refresh — re-introspect an existing connection. */
export async function refresh(c: Context) {
  const userId = userIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing connection id" }, 400);

  const url = await databaseConnectionStore.resolveUrl(userId, id);
  if (!url) return c.json({ error: "Connection not found" }, 404);

  await introspectConnection(id, userId, url);
  const connection = (await databaseConnectionStore.list(userId)).find((r) => r.id === id);
  return c.json({ connection });
}

/** DELETE /api/databases/:id — removes the snapshot and its search index too. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing connection id" }, 400);

  const removed = await databaseConnectionStore.remove(userIdOf(c), id);
  if (!removed) return c.json({ error: "Connection not found" }, 404);
  return c.body(null, 204);
}
