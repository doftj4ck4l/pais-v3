import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";

/** Reject cross-site browser mutations when an Origin header is present. */
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== env.publicUrl) {
        return c.json({ error: "Cross-origin mutations are not allowed." }, 403);
      }
    } catch {
      return c.json({ error: "Cross-origin mutations are not allowed." }, 403);
    }
  }
  await next();
};

/** JSON is non-simple under CORS and keeps secrets out of form/query encoding. */
export const requireJsonMutation: MiddlewareHandler = async (c, next) => {
  const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return c.json({ error: "Expected an application/json request body." }, 415);
  }
  return requireSameOrigin(c, next);
};
