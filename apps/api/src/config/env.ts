import os from "node:os";
import path from "node:path";
import { DEFAULT_DATABASE_ALLOWED_CIDRS } from "../services/db/network-policy";
import { parseSuperAdminEmails } from "../services/organizations/policy";

export function parsePublicUrl(raw: string | undefined): string {
  const value = raw?.trim() || "http://localhost:8080";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_URL must be an absolute http(s) origin.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("PUBLIC_URL must be an absolute http(s) origin without credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_URL must contain only an origin, without a path, query, or fragment.");
  }
  return parsed.origin;
}

export function parseOrganizationInviteTtlMs(raw: string | undefined): number {
  const hours = raw === undefined || raw.trim() === "" ? 168 : Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 8_760) {
    throw new Error("ORGANIZATION_INVITE_TTL_HOURS must be an integer from 1 to 8760.");
  }
  return hours * 60 * 60 * 1000;
}

export function parseAgentInvocationTimeoutMs(raw: string | undefined): number {
  const milliseconds = raw === undefined || raw.trim() === "" ? 180_000 : Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 300_000) {
    throw new Error("AGENT_INVOCATION_TIMEOUT_MS must be an integer from 1000 to 300000.");
  }
  return milliseconds;
}

export function parseUserPromptTimeoutMs(raw: string | undefined): number {
  // 10 minutes: long enough for a user to think, bounded enough that one who
  // walked away does not wedge the run (an approval was measured waiting ~24
  // min). 0 disables the bound; otherwise 30s–1h.
  const milliseconds = raw === undefined || raw.trim() === "" ? 600_000 : Number(raw);
  if (
    !Number.isInteger(milliseconds) ||
    (milliseconds !== 0 && (milliseconds < 30_000 || milliseconds > 3_600_000))
  ) {
    throw new Error("USER_PROMPT_TIMEOUT_MS must be 0 (disabled) or an integer from 30000 to 3600000.");
  }
  return milliseconds;
}

export type AuthMode = "proxy" | "dev" | "local";

export function parseAuthMode(raw: string | undefined): AuthMode {
  const value = raw?.trim() || "proxy";
  if (value !== "proxy" && value !== "dev" && value !== "local") {
    throw new Error("AUTH_MODE must be proxy, local, or dev.");
  }
  return value;
}

export function parseLocalSessionTtlMs(raw: string | undefined): number {
  const hours = raw === undefined || raw.trim() === "" ? 168 : Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new Error("LOCAL_SESSION_TTL_HOURS must be an integer from 1 to 720.");
  }
  return hours * 60 * 60 * 1000;
}

/**
 * Every environment variable the API reads, resolved once. Import this instead
 * of touching process.env, so the full configuration surface is one file.
 */
export const env = {
  port: Number(process.env.PORT || 4000),
  logLevel: process.env.LOG_LEVEL || "info",

  /** Trusted-email allowlist for the deliberately narrow v1 platform admin. */
  superAdminEmails: parseSuperAdminEmails(process.env.SUPER_ADMIN_EMAILS),

  /** One-time organization invitations expire after this duration. */
  organizationInviteTtlMs: parseOrganizationInviteTtlMs(
    process.env.ORGANIZATION_INVITE_TTL_HOURS,
  ),

  /** Maximum time a public prompt-agent request may occupy a provider connection. */
  agentInvocationTimeoutMs: parseAgentInvocationTimeoutMs(
    process.env.AGENT_INVOCATION_TIMEOUT_MS,
  ),

  /** Auto-cancel an unanswered ask_user / approval prompt after this long. */
  userPromptTimeoutMs: parseUserPromptTimeoutMs(process.env.USER_PROMPT_TIMEOUT_MS),

  /** Browser-session lifetime for AUTH_MODE=local. */
  localSessionTtlMs: parseLocalSessionTtlMs(process.env.LOCAL_SESSION_TTL_HOURS),

  /** OpenAI-compatible gateway that serves the model catalog. */
  gatewayBaseUrl: process.env.CUSTOM_BASE_URL ?? "http://60.51.17.97:9999/v1",

  /** Default user id, used only when `authMode` is `dev`. */
  defaultUserId: process.env.DEFAULT_USER_ID ?? "local",

  /**
   * How the API decides who is calling.
   *
   * `proxy` takes the identity from `authUserHeader` and refuses a request
   * that has none — correct wherever an authenticating proxy sits in front.
   * `dev` falls back to `defaultUserId` so `bun dev` needs no SSO stack.
   *
   * Defaults to `proxy` because the failure modes are not symmetric: a
   * deployment that forgets to set this would otherwise merge every tenant
   * into one shared account, silently.
   */
  authMode: parseAuthMode(process.env.AUTH_MODE),

  /**
   * Header carrying the authenticated user id. Authentik's proxy provider
   * sets `X-authentik-uid`, a stable id that survives a username change.
   */
  authUserHeader: (process.env.AUTH_USER_HEADER ?? "x-authentik-uid").toLowerCase(),

  /**
   * Where the agent's shell and file tools run.
   *
   * `pixelbox` runs each workspace's tools in a remote gVisor sandbox reached
   * over HTTPS (the Pixelbox service; see `services/sandbox/pixelbox-client.ts`),
   * which is the isolated, production stance. `node` executes the same tools
   * directly on this API host, as the user running the server: `cwd` is a
   * starting directory, not a boundary, so the agent can read anything that user
   * can — including this process's own environment and `.env`. Uploaded
   * documents make that reachable by prompt injection, so `node` is for a
   * trusted operator on a throwaway machine only, and stays the default so a
   * checkout with no Pixelbox credentials still runs.
   *
   * With `pixelbox` selected and the service unreachable, runs fail loudly
   * rather than falling back to the host — a silent fallback would hand the
   * model a shell.
   */
  sandboxBackend: (process.env.SANDBOX_BACKEND ?? "node") as "node" | "pixelbox",

  sandboxImage: process.env.SANDBOX_IMAGE ?? "pixelspace-sandbox:1",

  /** Workspace directories live here, one per workspace, and are never deleted. */
  sandboxRoot: process.env.SANDBOX_ROOT ?? path.join(os.homedir(), "pixelspace-workspaces"),

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
   * CIDRs database connectors may reach. Every resolved address must be in
   * this list; loopback, link-local, metadata, and multicast stay denied even
   * if a future environment broadens it.
   */
  databaseAllowedCidrs: (process.env.DATABASE_ALLOWED_CIDRS ?? DEFAULT_DATABASE_ALLOWED_CIDRS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),

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
  publicUrl: parsePublicUrl(process.env.PUBLIC_URL),

  /** Files one Drive sync will pull. Small by default; a demo, not a crawl. */
  connectorSyncLimit: Number(process.env.CONNECTOR_SYNC_LIMIT ?? 50),

  /**
   * OpenRouter, used only for image generation — the chat models come from the
   * gateway above. Absent, `generate_image` is not registered at all, the same
   * stance `connectionSecret` and the Google client take: a tool the model can
   * see but never satisfy is worse than one that is missing.
   */
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    "",
  ),
  /**
   * Default image model. Flash rather than pro because one pro image is ~4x the
   * cost and the tool is reachable from any prompt; override per call.
   */
  imageModel: process.env.IMAGE_MODEL ?? "google/gemini-3.1-flash-image",
  /**
   * Ceiling on images per single tool call. Gemini bills per output token, so a
   * request for "20 variations" is a real bill, not a rounding error.
   */
  imageMaxPerCall: Number(process.env.IMAGE_MAX_PER_CALL ?? 4),

  /**
   * The model that looks at an image on behalf of a chat model that cannot.
   *
   * Served by the same gateway as the chat models, so this needs no key of its
   * own — but it is a *different* model from the one running the conversation,
   * which is the entire point. `ds4-flash` answers "DeepSeek-V4-Flash-0731 is
   * not a multimodal model" to an image, and `nemotron-3.5-lightning` the same;
   * `qwen3.6-35b`, `qwen3.5-397b-instruct`, `vrs_smart` and
   * `gemini-3.1-flash-image` all read one. Measured, not assumed.
   *
   * The default is the cheap end deliberately: this tool is reachable from any
   * prompt, and the 397B describes a logo's typography unasked when the
   * question was "what does it say".
   */
  visionModel: process.env.VISION_MODEL ?? "qwen3.6-35b",
  /**
   * Largest image sent to the vision model, before base64 expansion.
   *
   * A data URI is ~4/3 of the bytes, and the whole thing rides in a JSON body,
   * so the cap is on the source. Past this the tool says so rather than letting
   * the gateway reject a multi-megabyte request with something unhelpful.
   */
  visionMaxBytes: Number(process.env.VISION_MAX_BYTES ?? 12_000_000),

  /**
   * RustFS — S3-compatible object storage for generated media.
   *
   * Bytes go here rather than into SQLite or the sandbox volume: the database
   * holds metadata that stays small, and the sandbox is per-workspace scratch
   * that gets rebuilt. `endpoint` is the compose service by default, so a dev
   * run without RustFS up degrades to a clear error rather than a wrong path.
   */
  s3Endpoint: (process.env.S3_ENDPOINT ?? "http://rustfs:9000").replace(/\/+$/, ""),
  // Existing deployments keep their explicit legacy bucket value. New
  // Pixelspace installs use the product name consistently.
  s3Bucket: process.env.S3_BUCKET ?? "pixelspace-media",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "rustfsadmin",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "",
  s3Region: process.env.S3_REGION ?? "us-east-1",
} as const;
