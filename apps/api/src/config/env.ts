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
   * `docker` gives each user an isolated container over a workspace that
   * outlives it, and is the default because the alternative is not safe by
   * default. `node` executes the same tools directly on this API host, as the
   * user running the server: `cwd` is a starting directory, not a boundary, so
   * the agent can read anything that user can — including this process's own
   * environment and `.env`. Uploaded documents make that reachable by prompt
   * injection, so `node` is for a trusted operator on a throwaway machine only.
   *
   * With `docker` selected and the daemon down, runs fail loudly rather than
   * falling back to the host — a silent fallback would hand the model a shell.
   */
  sandboxBackend: (process.env.SANDBOX_BACKEND ?? "docker") as "node" | "docker",

  sandboxImage: process.env.SANDBOX_IMAGE ?? "salurai-sandbox:1",

  /** Workspace directories live here, one per workspace, and are never deleted. */
  sandboxRoot: process.env.SANDBOX_ROOT ?? path.join(os.homedir(), "salurai-workspaces"),

  /** Remove a container after this long without a run. */
  sandboxIdleMs: Number(process.env.SANDBOX_IDLE_MS ?? 300_000),

  /**
   * Host directory holding SKILL.md skills, bind-mounted read-only into every
   * sandbox container. Resolved from the package root, not the process cwd, so
   * it does not depend on where the server was started from.
   */
  skillsRoot: process.env.SKILLS_ROOT ?? path.resolve(import.meta.dirname, "..", "..", "skills"),

  /**
   * Key material for encrypting stored database connection strings. Absent, the
   * API refuses to store one rather than writing it in plaintext — the same
   * stance the sandbox takes when Docker is down.
   */
  connectionSecret: process.env.CONNECTION_SECRET ?? "",

  /**
   * OAuth client for the Google Drive connector. Absent, the connector is
   * simply not offered — the same stance as `connectionSecret`, since half a
   * credential produces a consent screen that fails after the user has already
   * approved it.
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",

  /**
   * How this API is reached from a browser, used to build the OAuth redirect.
   *
   * It must match an Authorized redirect URI on the Google client exactly, and
   * Google compares the string, not the host it resolves to. Configurable
   * because the API is reached through the web proxy's port, not its own.
   */
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/+$/, ""),

  /** Files one Drive sync will pull. Small by default; a demo, not a crawl. */
  connectorSyncLimit: Number(process.env.CONNECTOR_SYNC_LIMIT ?? 50),
} as const;
