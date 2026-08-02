import os from "node:os";
import path from "node:path";

/**
 * Every environment variable the API reads, resolved once. Import this instead
 * of touching process.env, so the full configuration surface is one file.
 */
export const env = {
  port: Number(process.env.PORT || 4000),
  logLevel: process.env.LOG_LEVEL || "info",

  /** OpenAI-compatible gateway that serves the model catalog. */
  gatewayBaseUrl: process.env.CUSTOM_BASE_URL ?? "http://60.51.17.97:9999/v1",

  /** Default user id when a request doesn't carry one. */
  defaultUserId: process.env.DEFAULT_USER_ID ?? "local",

  /**
   * Where the agent's shell and file tools run.
   *
   * `node` executes them on this API host — fine for a trusted developer, and
   * the default so the sandbox work stays inert until switched on. `docker`
   * gives each user an isolated container over a workspace that outlives it.
   */
  sandboxBackend: (process.env.SANDBOX_BACKEND ?? "node") as "node" | "docker",

  sandboxImage: process.env.SANDBOX_IMAGE ?? "node:22-bookworm-slim",

  /** Workspaces live here, one directory per user, and are never deleted. */
  sandboxRoot: process.env.SANDBOX_ROOT ?? path.join(os.homedir(), "mixmatch-workspaces"),

  /** Remove a container after this long without a run. */
  sandboxIdleMs: Number(process.env.SANDBOX_IDLE_MS ?? 300_000),
} as const;
