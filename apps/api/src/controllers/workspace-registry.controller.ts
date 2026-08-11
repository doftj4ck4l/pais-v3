import type { Context } from "hono";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { env } from "../config/env";
import { currentUserId } from "../middleware/auth";

const userIdOf = (c: Context) => currentUserId(c);

/** GET /api/workspaces — a user's workspaces, oldest first, creating one if none exist. */
export async function index(c: Context) {
  const userId = userIdOf(c);
  // Resolving first guarantees the client always has at least one to select.
  await workspaceRegistry.resolve(userId);
  return c.json({ workspaces: await workspaceRegistry.list(userId) });
}

/** POST /api/workspaces — a new, empty body of work. */
export async function create(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const workspace = await workspaceRegistry.create(userIdOf(c), body.name ?? "Untitled");
  return c.json({ workspace }, 201);
}

/** PATCH /api/workspaces/:id — rename. */
export async function update(c: Context) {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  if (!id || !body.name) return c.json({ error: "Missing id or name" }, 400);
  const renamed = await workspaceRegistry.rename(id, userIdOf(c), body.name);
  if (!renamed) return c.json({ error: "Workspace not found" }, 404);
  return c.body(null, 204);
}

/** DELETE /api/workspaces/:id — removes its agents, documents and connections too. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const userId = userIdOf(c);
  if (await workspaceRegistry.remove(id, userId)) return c.body(null, 204);

  // `remove` refuses for two different reasons, and the client needs to tell
  // them apart: a workspace that is still there was the user's last one, and
  // saying "not found" about it would be a lie.
  const still = await workspaceRegistry.getOwned(id, userId);
  if (still) return c.json({ error: "Cannot remove the last workspace" }, 409);
  return c.json({ error: "Workspace not found" }, 404);
}
