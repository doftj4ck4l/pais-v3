import { createApp } from "./app";
import { ensureSchema } from "./db/client";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { startSandboxReaper } from "./services/sandbox/sandbox.service";

ensureSchema();

// Idle containers are only cleaned up if something is watching for them.
if (env.sandboxBackend === "docker") startSandboxReaper();

const app = createApp();

logger.info("api.listening", {
  url: `http://localhost:${env.port}`,
  sandbox: env.sandboxBackend,
});

export default { port: env.port, fetch: app.fetch };
