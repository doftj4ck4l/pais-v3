import { createApp } from "./app";
import { ensureSchema } from "./db/client";
import { env } from "./config/env";
import { logger } from "./lib/logger";

ensureSchema();

const app = createApp();

logger.info("api.listening", { url: `http://localhost:${env.port}` });

export default { port: env.port, fetch: app.fetch };
