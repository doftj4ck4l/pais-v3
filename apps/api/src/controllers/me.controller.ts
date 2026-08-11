import type { Context } from "hono";
import { currentUser, currentUserId, type UserProfile } from "../middleware/auth";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";

/** Longer than this is not a name, it is a paragraph in a name field. */
const MAX_NAME = 80;

/** The proxy's profile, with our one stored preference laid over it. */
type Profile = UserProfile & {
  displayName: string | null;
  /**
   * The provider's own name, before any override. Sent so the settings field
   * can say what clearing it would restore — `name` cannot answer that, since
   * once an override exists it *is* the override.
   */
  providerName: string | null;
};

async function profileFor(c: Context): Promise<Profile> {
  const proxy = currentUser(c);
  const displayName = await workspaceRegistry.displayName(proxy.id);
  // `name` is what the console renders; `displayName` is the override on its
  // own, so the settings screen can tell "set to the same thing" apart from
  // "not set" and offer to clear it.
  return {
    ...proxy,
    name: displayName ?? proxy.name,
    displayName,
    providerName: proxy.name ?? null,
  };
}

/**
 * GET /api/me — who the proxy says you are.
 *
 * The console has no login of its own, so without this it cannot tell the
 * difference between an authenticated session and an open door. The identity
 * itself is not read from our database: the provider is the authority, and the
 * headers arrive on every request already.
 */
export async function show(c: Context) {
  return c.json(await profileFor(c));
}

/**
 * PATCH /api/me — change what this console calls you.
 *
 * Only the display name. Email, username and groups come from the identity
 * provider and are not ours to edit: writing them here would produce a console
 * that disagrees with every other app behind the same login, and would be
 * overwritten by the next request's headers anyway. Changing those means
 * changing them at the provider.
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
  return c.json(await profileFor(c));
}
