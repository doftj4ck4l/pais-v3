import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
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
const CLIENT_INFO = { name: "salur", version: "1.0.0" };

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
  await withTimeout(
    client.connect(
      new StdioClientTransport({
        command,
        args,
        env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
        stderr: "pipe",
      }),
    ),
    timeoutMs,
    `connect to "${spec.name}"`,
  );
  return client;
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
