import type { Context } from "hono";
import { currentUser } from "../middleware/auth";

/**
 * GET /api/me — who the proxy says you are.
 *
 * The console has no login of its own, so without this it cannot tell the
 * difference between an authenticated session and an open door. Nothing here
 * is read from our database: the identity provider is the authority, and the
 * headers arrive on every request already.
 */
export async function show(c: Context) {
  return c.json(currentUser(c));
}
