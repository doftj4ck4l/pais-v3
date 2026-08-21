import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./middleware/auth";
import type { MiddlewareHandler } from "hono";
import { requestLogger } from "./middleware/request-logger";
import { requireSameOrigin } from "./middleware/json-mutation";
import { apiRoutes } from "./routes";

/**
 * Routes that answer without an identity.
 *
 * `/api/meta` is the model and harness catalog, carries no tenant data, and is
 * what the container healthcheck calls — gating it would report the API as
 * unhealthy the moment auth was switched on.
 */
const OPEN_PATHS = new Set([
  "/api/meta",
  "/api/agents/invoke",
  "/api/auth/config",
  "/api/auth/login",
]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The wired-up Hono app: middleware, then routes. No side effects on import. */
export function createApp(options: { authMiddleware?: MiddlewareHandler } = {}) {
  const app = new Hono();
  const authenticate = options.authMiddleware ?? auth;

  app.use("*", cors());
  app.use("*", requestLogger);
  app.use("/api/*", (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || c.req.path === "/api/agents/invoke") return next();
    return requireSameOrigin(c, next);
  });
  app.use("/api/*", (c, next) =>
    OPEN_PATHS.has(c.req.path) ? next() : authenticate(c, next),
  );

  app.route("/api", apiRoutes);

  return app;
}
