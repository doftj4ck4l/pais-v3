import type { Context, MiddlewareHandler } from "hono";
import { env } from "../config/env";

export type AuthMode = "proxy" | "dev";

export interface AuthOptions {
  mode?: AuthMode;
  header?: string;
  defaultUserId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    userId: string;
  }
}

/**
 * Establishes who is calling, once, for every request.
 *
 * The identity comes from a header set by the authenticating proxy and from
 * nowhere else. It used to come from `?userId=`, which meant any caller could
 * name any tenant and the registry would hand over that tenant's workspaces —
 * the ownership check downstream is sound, but it was being asked the wrong
 * question.
 *
 * That header is only trustworthy because nothing but the proxy can reach this
 * API: the deploy host drops traffic to the published port from anywhere but
 * the edge. Publish the port more widely and the header becomes forgeable
 * again, so the firewall rule is part of this control, not separate from it.
 *
 * `proxy` refuses a request it cannot attribute rather than falling back to a
 * shared account, on the same grounds the sandbox refuses to run on the host
 * when Docker is down: a silent fallback would quietly merge every tenant into
 * one. `dev` exists so `bun dev` works without an SSO stack in front of it.
 */
export function createAuth(opts: AuthOptions = {}): MiddlewareHandler {
  const mode = opts.mode ?? env.authMode;
  const header = opts.header ?? env.authUserHeader;
  const fallbackUserId = opts.defaultUserId ?? env.defaultUserId;

  return async (c, next) => {
    const claimed = c.req.header(header)?.trim();

    if (claimed) {
      c.set("userId", claimed);
      return next();
    }

    if (mode === "proxy") {
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("userId", fallbackUserId);
    await next();
  };
}

/** The middleware above runs before every handler, so this is always set. */
export const currentUserId = (c: Context): string => c.get("userId");

export const auth = createAuth();
