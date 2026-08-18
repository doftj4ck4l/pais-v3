import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";
import { currentUser } from "./auth";
import { isSuperAdmin } from "../services/organizations/policy";

export function createRequireSuperAdmin(
  allowedEmails?: readonly string[],
): MiddlewareHandler {
  return async (c, next) => {
    // Read environment policy at request time unless a test explicitly injects
    // a fixed allowlist. This also keeps controlled runtime config overrides
    // consistent with /api/me instead of capturing a stale empty array.
    if (!isSuperAdmin(currentUser(c).email, allowedEmails ?? env.superAdminEmails)) {
      return c.json({ error: "You are not authorized to administer organizations." }, 403);
    }
    await next();
  };
}

export const requireSuperAdmin = createRequireSuperAdmin();
