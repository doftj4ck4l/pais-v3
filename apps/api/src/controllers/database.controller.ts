import type { Context } from "hono";
import { databaseConnectionStore } from "../repositories/database-connection.repository";
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

  await databaseConnectionStore.create({ id, userId, name, url, displayHost, displayDatabase });

  if (!reached.ok) {
    await databaseConnectionStore.markStatus(id, "error", reached.error);
    logger.warn("db.connect_failed", { id, name, error: reached.error });
    return c.json({ connection: (await databaseConnectionStore.list(userId))[0] }, 201);
  }

  await introspectConnection(id, userId, url);
  const connection = (await databaseConnectionStore.list(userId)).find((r) => r.id === id);
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
