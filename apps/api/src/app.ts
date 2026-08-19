import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./middleware/auth";
import { requestLogger } from "./middleware/request-logger";
import { apiRoutes } from "./routes";

/**
 * Routes that answer without an identity.
 *
 * `/api/meta` is the model and harness catalog, carries no tenant data, and is
 * what the container healthcheck calls — gating it would report the API as
 * unhealthy the moment auth was switched on.
 */
const OPEN_PATHS = new Set(["/api/meta", "/api/agents/invoke"]);

/** The wired-up Hono app: middleware, then routes. No side effects on import. */
export function createApp() {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", requestLogger);
  app.use("/api/*", (c, next) => (OPEN_PATHS.has(c.req.path) ? next() : auth(c, next)));

  app.route("/api", apiRoutes);

  return app;
}
