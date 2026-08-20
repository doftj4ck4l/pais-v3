import type { Context } from "hono";
import { currentUser, currentUserId } from "../middleware/auth";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { authenticatedProfileFor } from "../services/auth/profile";

/** Longer than this is not a name, it is a paragraph in a name field. */
const MAX_NAME = 80;

/**
 * GET /api/me — the identity established by the active auth mode.
 */
export async function show(c: Context) {
  return c.json(await authenticatedProfileFor(currentUser(c)));
}

/**
 * PATCH /api/me — change what this console calls you.
 *
 * Only the display name. Email, username and groups are account identity, not
 * profile preferences, regardless of whether they came from a proxy or local
 * credentials.
 *
 * An empty string clears the override rather than setting an empty name, so
 * the field is also how you undo it.
 */
export async function update(c: Context) {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected a JSON body." }, 400);
  }

  const raw = (body as { displayName?: unknown }).displayName;
  if (raw !== null && typeof raw !== "string") {
    return c.json({ error: "displayName must be a string or null." }, 400);
  }

  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > MAX_NAME) {
    return c.json({ error: `A name can be at most ${MAX_NAME} characters.` }, 400);
  }

  await workspaceRegistry.setDisplayName(currentUserId(c), trimmed || null);
  return c.json(await authenticatedProfileFor(currentUser(c)));
}
