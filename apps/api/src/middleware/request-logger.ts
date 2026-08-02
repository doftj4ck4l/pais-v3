import type { MiddlewareHandler } from "hono";
import { logger, startTimer } from "../lib/logger";

/** One structured line per request, after the handler resolves. */
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const timer = startTimer();
  await next();
  logger.info("http", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: timer.elapsed(),
  });
};
