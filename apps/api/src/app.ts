import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestLogger } from "./middleware/request-logger";
import { apiRoutes } from "./routes";

/** The wired-up Hono app: middleware, then routes. No side effects on import. */
export function createApp() {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", requestLogger);

  app.route("/api", apiRoutes);

  return app;
}
