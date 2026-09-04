import { createApp } from "./app";
import { ensureSchema } from "./db/client";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { startSandboxReaper } from "./services/sandbox/sandbox.service";
import { recoverInterruptedRuns } from "./services/agent/run-recovery";

ensureSchema();
await recoverInterruptedRuns();

// Idle containers are only cleaned up if something is watching for them.
if (env.sandboxBackend === "docker") startSandboxReaper();

const app = createApp();

logger.info("api.listening", {
  url: `http://localhost:${env.port}`,
  sandbox: env.sandboxBackend,
});

export default {
  port: env.port,
  fetch: app.fetch,
  /**
   * Bun closes an idle connection after 10s by default, which is wrong for this
   * server: /api/chat is an SSE stream that goes quiet for as long as a tool
   * takes. A single web fetch or skill invocation outlasts the default, and the
   * dropped connection surfaces as a run mysteriously ending in `stopped`.
   *
   * 255 is Bun's maximum and comfortably exceeds the 120s cap on a skill run,
   * so the tool timeout is what ends a slow call, not the transport.
   */
  idleTimeout: 255,
};
