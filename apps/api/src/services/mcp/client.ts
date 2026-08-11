import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpTransport } from "../../models/schema";
import { checkStdioCommand } from "./allowlist";
import { logger } from "../../lib/logger";

/**
 * Opening one connection to one MCP server.
 *
 * Deliberately knows nothing about workspaces, storage, or Pi. It takes a fully
 * resolved spec — secrets already decrypted by the repository — and hands back
 * a connected SDK client. That is what lets `mcp-tools` be tested against a
 * real server over an in-memory transport by substituting the connector.
 */

/** How we identify ourselves to a server during initialize. */
const CLIENT_INFO = { name: "pixelspace", version: "1.0.0" };

/** A remote server that has not completed initialize by now is unreachable. */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Longer for stdio, because the first connection to a new server is not a
 * connection — it is a download. `uvx nextcloud-mcp-server` fetches and builds
 * a Python environment before it says a word, which is minutes on a cold cache
 * and milliseconds on a warm one. Ten seconds would mean every stdio server
 * fails the first time it is added and works when retried, which reads as a
 * broken feature rather than a slow one.
 */
export const STDIO_CONNECT_TIMEOUT_MS = 180_000;

/** The connect budget for a spec, by transport. */
export function connectTimeoutFor(transport: McpTransport): number {
  return transport === "stdio" ? STDIO_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
}

/** A tool call that has not returned by now is abandoned so the run can continue. */
export const CALL_TIMEOUT_MS = 60_000;

/**
 * Where stdio servers' scratch directories live.
 *
 * `/tmp` rather than `HOME`: nothing here is worth keeping between runs, and a
 * working directory that does not survive a restart cannot accumulate one
 * server's leftovers into another server's startup.
 */
export const MCP_CWD_ROOT = process.env.MCP_CWD_ROOT || path.join(os.tmpdir(), "salur-mcp");

/**
 * The directory a stdio server's process starts in.
 *
 * Not ours, which is what a child inherits by default. A working directory is
 * readable configuration to anything that looks for a dotfile in it, and
 * `fastmcp` does exactly that: importing it constructs a pydantic `Settings()`,
 * which reads `.env` relative to the cwd. Inheriting ours pointed every fastmcp
 * server at the API's own `apps/api/.env` — `CONNECTION_SECRET`, model keys —
 * and invited it to load that as its configuration.
 *
 * What we saw was the crash, not the leak: in the deployed image that file is
 * mode 600 root:root while the API runs as uid 1000, so `uvx plane-mcp-server`
 * died on import with `PermissionError: [Errno 13] Permission denied: '.env'`
 * and the transport reported "Connection closed". The failure was the lucky
 * outcome — under `bun dev` the same file is readable by the same user, and the
 * secrets would have loaded without a word.
 *
 * `connectStdio` already refuses to hand a child `process.env`, building its
 * environment explicitly instead. The working directory is that same decision,
 * and it was the half left open.
 *
 * One directory per server, so a file one of them writes is not something the
 * next one reads. The id is reduced to a bare name first: it arrives from the
 * database, and a cwd assembled by joining strings is one bad row away from
 * naming a directory outside the root.
 */
export function stdioCwd(serverId: string): string {
  const safe = path.basename(String(serverId ?? "")).replace(/[^A-Za-z0-9._-]/g, "") || "unnamed";
  const dir = path.join(MCP_CWD_ROOT, safe);
  // Spawning into a directory that does not exist fails as ENOENT on the
  // command itself, which reads as "this server is broken".
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export type McpServerSpec = {
  id: string;
  name: string;
  transport: McpTransport;
  url?: string | null;
  headers?: Record<string, string>;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
};

export type McpConnection = {
  spec: McpServerSpec;
  client: Client;
  close(): Promise<void>;
};

/** Substituted in tests with a connector backed by `InMemoryTransport`. */
export type Connector = (spec: McpServerSpec, timeoutMs?: number) => Promise<McpConnection>;

/**
 * Reject if a promise has not settled in time.
 *
 * `client.connect` on a dead host can hang for as long as the OS keeps the
 * socket in SYN_SENT. A run must not wait that long for a server it may not
 * even need.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Streamable HTTP first, SSE second.
 *
 * Streamable HTTP is the current transport; SSE is what servers written against
 * the earlier spec still speak. Trying one and falling back is the only way to
 * support both from a single URL, since nothing in the URL says which it is.
 */
async function connectHttp(spec: McpServerSpec, timeoutMs: number): Promise<Client> {
  const url = new URL(String(spec.url ?? ""));
  const requestInit = Object.keys(spec.headers ?? {}).length
    ? { headers: { ...spec.headers } }
    : undefined;

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await withTimeout(
      client.connect(new StreamableHTTPClientTransport(url, { requestInit })),
      timeoutMs,
      `connect to "${spec.name}"`,
    );
    return client;
  } catch (streamableError) {
    // A fresh Client: the failed one has already run part of initialize, and
    // reusing it would replay that state onto the second transport.
    logger.info("mcp.http_fallback_sse", {
      server: spec.name,
      message: (streamableError as Error)?.message,
    });
    const sseClient = new Client(CLIENT_INFO, { capabilities: {} });
    await withTimeout(
      sseClient.connect(new SSEClientTransport(url, { requestInit })),
      timeoutMs,
      `connect to "${spec.name}"`,
    );
    return sseClient;
  }
}

/**
 * Spawn a local server, but only a permitted one.
 *
 * The env is built explicitly from the SDK's safe-to-inherit set plus whatever
 * the user configured, rather than handing the child `process.env` — the API
 * process holds model API keys and the database credential key, and none of
 * that belongs in a third-party server's environment.
 */
async function connectStdio(spec: McpServerSpec, timeoutMs: number): Promise<Client> {
  const command = String(spec.command ?? "");
  const args = spec.args ?? [];

  const allowed = checkStdioCommand(command, args);
  if (!allowed.ok) throw new Error(allowed.reason);

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
    // See `stdioCwd`: a child left in our directory reads our dotfiles.
    cwd: stdioCwd(spec.id),
    stderr: "pipe",
  });

  // Nothing used to read this pipe, and that is why a failed server was
  // untroubleshootable: a launcher that dies during startup says why on
  // stderr — a Python traceback, "No solution found when resolving", an auth
  // rejection — and all of it was discarded. What surfaced instead was the
  // timeout that followed, which names the symptom and never the cause.
  //
  // The SDK hands back a PassThrough as soon as `stderr: "pipe"` is set,
  // before the child is spawned, so this listener cannot miss the first write.
  const stderrTail = captureStderr(transport);

  try {
    await withTimeout(client.connect(transport), timeoutMs, `connect to "${spec.name}"`);
  } catch (e) {
    throw withStderr(e as Error, stderrTail());
  }
  return client;
}

/** How much of a failing server's stderr to keep. A traceback, not a session. */
const STDERR_CAP = 4000;

/**
 * Drain a transport's stderr into a capped tail.
 *
 * Capped from the front rather than the back: the useful part of a startup
 * failure is the last thing said before it gave up, not the banner it printed
 * first.
 */
// Structural rather than `Stream`: the SDK types this getter as `Stream | null`,
// which does not carry `read`/`setEncoding`, and `on` is all this needs.
type StderrSource = { on(event: string, listener: (chunk: unknown) => void): unknown } | null;

function captureStderr(transport: { stderr: StderrSource }): () => string {
  let buffer = "";
  const stream = transport.stderr;
  stream?.on("data", (chunk: unknown) => {
    buffer += String(chunk);
    if (buffer.length > STDERR_CAP) buffer = buffer.slice(-STDERR_CAP);
  });
  // Never let a broken pipe become a second, unrelated failure.
  stream?.on("error", () => {});
  return () => buffer.trim();
}

/**
 * Attach captured output to an error without losing its own message.
 *
 * The two are kept as separate lines so a caller can show the summary in a row
 * and the detail behind a click.
 */
export class McpConnectError extends Error {
  constructor(
    message: string,
    /** Whatever the process said on the way down. Empty when it said nothing. */
    readonly detail: string,
  ) {
    super(message);
    this.name = "McpConnectError";
  }
}

function withStderr(error: Error, stderr: string): Error {
  if (!stderr) return error;
  return new McpConnectError(error.message, stderr);
}

/** Connect to one server over whichever transport it declares. */
export const connectMcpServer: Connector = async (spec, timeoutMs) => {
  const budget = timeoutMs ?? connectTimeoutFor(spec.transport);
  const client =
    spec.transport === "stdio"
      ? await connectStdio(spec, budget)
      : await connectHttp(spec, budget);

  return {
    spec,
    client,
    async close() {
      // Closing is best-effort by design: a server that died mid-run must not
      // turn cleanup into a second failure on top of the first.
      await client.close().catch(() => {});
    },
  };
};
