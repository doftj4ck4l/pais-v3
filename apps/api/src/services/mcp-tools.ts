import type { PromptTemplate } from "@earendil-works/pi-agent-core";
import { jsonSchemaToTypebox } from "../lib/typebox-schema";
import { logger } from "../lib/logger";
import {
  mcpStore,
  type McpStore,
  type NewCapability,
} from "../repositories/mcp.repository";
import {
  CALL_TIMEOUT_MS,
  connectMcpServer,
  type Connector,
  type McpConnection,
  type McpServerSpec,
} from "./mcp/client";
import { listCapabilities } from "./mcp/probe";

/**
 * Every MCP server a workspace has enabled, adapted into what a pi run needs:
 * tools, prompt templates, and a system-prompt block.
 *
 * Connections are opened here and live for exactly one run — `dispose()` is
 * called from the same `finally` that cleans up the execution environment. A
 * pool would need health checks, reconnection, and per-workspace eviction to
 * earn its keep; runs are short enough that connecting each time is the
 * smaller correct thing.
 *
 * Nothing in here can fail a run. A server that will not connect is recorded,
 * skipped, and the remaining servers still contribute their tools.
 */

export type McpServerOutcome = {
  name: string;
  transport: string;
  ok: boolean;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  /** How long connecting and listing this one server took. */
  ms: number;
};

export type McpRuntime = {
  /** Pi AgentTools, ready to concatenate onto the harness tool list. */
  tools: any[];
  /** Pi prompt templates, ready to concatenate onto `resources.promptTemplates`. */
  promptTemplates: PromptTemplate[];
  /** What happened to each server, for logging and for the UI. */
  servers: McpServerOutcome[];
  /** Text naming the connected servers and their tools; empty when there are none. */
  systemPromptBlock: string;
  dispose(): Promise<void>;
};

const EMPTY_RUNTIME: Omit<McpRuntime, "dispose"> = {
  tools: [],
  promptTemplates: [],
  servers: [],
  systemPromptBlock: "",
};

/**
 * Reduce a server or tool name to something a model can call.
 *
 * Providers reject tool names outside `[A-Za-z0-9_-]`, and MCP puts no such
 * limit on its own names. A server called "My Server (prod)" has to become
 * `my_server_prod` before any of its tools can be offered at all.
 */
export function slugify(name: string): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "server";
}

/**
 * Characters of one MCP result handed to the model.
 *
 * An MCP server is a live system whose result size nobody here controls: one
 * `search_files` against a real Nextcloud returned 239,701 characters — about
 * 60k tokens, half a 123k context window, in a single call. The turn after it
 * had no room left to answer in and produced nothing, which reads as a hung UI
 * rather than an overflow.
 *
 * This is the same stance `db-tools` takes with BYTE_CAP, for the same reason,
 * and it belongs on the boundary where untrusted size enters — not on each of
 * the 151 tools a server might expose.
 *
 * 40k characters is roughly 10k tokens: enough for a real answer, an order of
 * magnitude below the window.
 */
export const RESULT_CHAR_CAP = 40_000;

/**
 * Characters of MCP output one whole run may consume.
 *
 * A per-call cap alone is not enough, and the reason showed up the first time
 * it was tried: the model issued six `read_file` calls in parallel, each was
 * capped at 40,000, and the turn still carried 240,000 characters. Capping the
 * call bounds the call; only a run-level budget bounds the run.
 *
 * Spent budget is never returned. A run that has already read 120k characters
 * and still has no answer will not find it in another 40k — it needs to ask a
 * narrower question, and saying so is more useful than letting it continue.
 */
export const RUN_CHAR_BUDGET = 120_000;

/**
 * Truncate an oversized result and tell the model what happened.
 *
 * The notice matters as much as the cut. Silently truncated JSON parses as
 * corrupt, and a model that cannot tell truncation from "this is all there is"
 * will summarise a fraction of the data as if it were the whole.
 */
export function capResult(text: string, cap = RESULT_CHAR_CAP): string {
  if (text.length <= cap) return text;
  const dropped = text.length - cap;
  return (
    text.slice(0, cap) +
    `\n\n[truncated: ${dropped.toLocaleString()} of ${text.length.toLocaleString()} characters ` +
    `were dropped to fit the context window. This output is INCOMPLETE — do not treat it as ` +
    `the full result. Narrow the call (a more specific path, pattern, or limit) and try again.]`
  );
}

/** Flatten an MCP tool result's content blocks into the text a Pi tool returns. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "resource") {
        return block.resource?.text ?? `[resource ${block.resource?.uri ?? ""}]`;
      }
      // Images and audio cannot be inlined into a text result. Naming the type
      // is more useful to the model than silently dropping the block.
      if (block?.type) return `[${block.type}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * A run's remaining MCP output allowance.
 *
 * One of these per `createMcpTools` call, closed over by every tool it builds,
 * so the budget is per run — which is the unit that shares a context window.
 */
export function createBudget(total = RUN_CHAR_BUDGET) {
  let remaining = total;
  return {
    remaining: () => remaining,
    /** Cap `text` against both the per-call limit and what the run has left. */
    take(text: string): string {
      if (remaining <= 0) {
        return (
          `[skipped: this run has already read ${total.toLocaleString()} characters from MCP ` +
          `servers, which is its budget. Do not retry this call. Answer from what you already ` +
          `have, or tell the user the request is too broad and what narrower one would work.]`
        );
      }
      const capped = capResult(text, Math.min(RESULT_CHAR_CAP, remaining));
      remaining -= capped.length;
      return capped;
    },
  };
}

type Budget = ReturnType<typeof createBudget>;

/**
 * Shape a Pi tool result, error or not.
 *
 * Every MCP result passes through this one function, so a tool added later
 * cannot forget to bound its output — and errors go through it too, since a
 * server is equally capable of returning a 200KB stack trace.
 */
function toolResult(budget: Budget, text: string, isError = false) {
  const capped = budget.take(text);
  return {
    content: [{ type: "text" as const, text: capped }],
    details: { output: capped },
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Race a call against the timeout so one unresponsive server cannot stall a
 * run indefinitely. The call is abandoned, not cancelled — the SDK owns the
 * request — but the agent gets an answer and can move on.
 */
async function withCallTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${CALL_TIMEOUT_MS}ms`)),
          CALL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One connected server plus what it advertised. */
type Live = {
  serverId: string;
  name: string;
  slug: string;
  conn: McpConnection;
  caps: NewCapability[];
};

export async function createMcpTools(
  workspaceId: string,
  store: McpStore = mcpStore,
  connector: Connector = connectMcpServer,
): Promise<McpRuntime> {
  const rows = await store.listEnabled(workspaceId);
  if (!rows.length) return { ...EMPTY_RUNTIME, dispose: async () => {} };

  const outcomes: McpServerOutcome[] = [];
  const live: Live[] = [];

  // Connected in parallel: a run should wait for the slowest server, not the
  // sum of all of them.
  const attempts = await Promise.all(
    rows.map(async (row) => {
      const secrets = await store.resolveSecrets(workspaceId, row.id);
      const spec: McpServerSpec = {
        id: row.id,
        name: row.name,
        transport: row.transport,
        url: row.url,
        headers: secrets?.headers ?? {},
        command: row.command,
        args: row.argsJson ? (JSON.parse(row.argsJson) as string[]) : [],
        env: secrets?.env ?? {},
      };

      const startedAt = Date.now();
      try {
        const conn = await connector(spec);
        const caps = await listCapabilities(conn);
        return { row, conn, caps, error: null as string | null, ms: Date.now() - startedAt };
      } catch (e) {
        return {
          row,
          conn: null,
          caps: [],
          error: (e as Error)?.message ?? String(e),
          ms: Date.now() - startedAt,
        };
      }
    }),
  );

  for (const attempt of attempts) {
    const { row, conn, caps, error, ms } = attempt;

    if (!conn) {
      logger.warn("mcp.connect_failed", { server: row.name, message: error });
      await store.markStatus(workspaceId, row.id, "error", error);
      outcomes.push({
        name: row.name,
        transport: row.transport,
        ok: false,
        error: error ?? "unknown error",
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        ms,
      });
      continue;
    }

    // The cache is refreshed from what the server just said, so the settings UI
    // and the next run's prompt reflect reality without a separate probe.
    await store.saveCapabilities(workspaceId, row.id, caps);
    await store.markStatus(workspaceId, row.id, "connected", null);

    const toolCount = caps.filter((c) => c.kind === "tool").length;
    outcomes.push({
      name: row.name,
      transport: row.transport,
      ok: true,
      toolCount,
      resourceCount: caps.filter((c) => c.kind === "resource").length,
      promptCount: caps.filter((c) => c.kind === "prompt").length,
      ms,
    });
    live.push({ serverId: row.id, name: row.name, slug: slugify(row.name), conn, caps });
  }

  const dispose = async () => {
    await Promise.all(live.map((l) => l.conn.close()));
  };

  if (!live.length) {
    return { ...EMPTY_RUNTIME, servers: outcomes, dispose };
  }

  const byName = new Map(live.map((l) => [l.name, l]));
  const tools: any[] = [];
  // One allowance for this run, shared by every tool below. Per call *and* per
  // run: six parallel reads, each individually within the per-call cap, are
  // what exhausted a context window the first time only the per-call cap
  // existed.
  const budget = createBudget();

  // --- one Pi tool per MCP tool, namespaced by server ---
  // Two servers may each offer "search"; without the prefix the second would
  // silently shadow the first in the model's tool list.
  const taken = new Set<string>();
  for (const server of live) {
    for (const cap of server.caps.filter((c) => c.kind === "tool")) {
      let name = `${server.slug}__${slugify(cap.name)}`;
      if (taken.has(name)) {
        // Only reachable when two distinct server names slugify identically.
        // Suffixing keeps both callable rather than dropping one.
        let n = 2;
        while (taken.has(`${name}_${n}`)) n++;
        name = `${name}_${n}`;
      }
      taken.add(name);

      const toolName = cap.name;
      const conn = server.conn;
      const serverName = server.name;

      tools.push({
        name,
        label: name,
        description:
          (cap.description ?? `The "${toolName}" tool.`) + ` (MCP server: ${serverName})`,
        parameters: jsonSchemaToTypebox(
          cap.schemaJson ? (JSON.parse(cap.schemaJson) as Record<string, unknown>) : undefined,
        ),
        execute: async (_id: string, params: any) => {
          try {
            const result: any = await withCallTimeout(
              conn.client.callTool({ name: toolName, arguments: params ?? {} }),
              `${serverName}.${toolName}`,
            );
            const text = flattenContent(result?.content);
            return toolResult(budget, text || "(no output)", result?.isError === true);
          } catch (e) {
            // Returned, not thrown: the model can pick another approach, and a
            // flaky server does not end the run.
            return toolResult(budget, `MCP call failed: ${(e as Error)?.message ?? String(e)}`, true);
          }
        },
      });
    }
  }

  // --- resources: two flat tools, however many resources exist ---
  // One tool per resource would put an unbounded list into every system prompt.
  const resourceServers = live.filter((l) => l.caps.some((c) => c.kind === "resource"));
  if (resourceServers.length) {
    tools.push({
      name: "mcp_list_resources",
      label: "mcp_list_resources",
      description:
        "List the resources MCP servers expose. Returns each resource's server, uri, and " +
        "description. Read one with mcp_read_resource.",
      parameters: jsonSchemaToTypebox({
        type: "object",
        properties: { server: { type: "string", description: "limit to one server by name" } },
      }),
      execute: async (_id: string, params: any) => {
        const wanted = String(params?.server ?? "").trim();
        const chosen = wanted ? resourceServers.filter((s) => s.name === wanted) : resourceServers;
        if (wanted && !chosen.length) {
          return toolResult(budget, 
            `unknown server "${wanted}" — available: ${resourceServers.map((s) => s.name).join(", ")}`,
            true,
          );
        }
        const lines = chosen.flatMap((s) =>
          s.caps
            .filter((c) => c.kind === "resource")
            .map((c) => `${s.name}\t${c.uri}\t${c.description ?? c.name}`),
        );
        return toolResult(budget, lines.length ? lines.join("\n") : "no resources");
      },
    });

    tools.push({
      name: "mcp_read_resource",
      label: "mcp_read_resource",
      description: "Read one MCP resource by its uri. Find uris with mcp_list_resources.",
      parameters: jsonSchemaToTypebox({
        type: "object",
        properties: {
          server: { type: "string", description: "the server that exposes it" },
          uri: { type: "string", description: "the resource uri" },
        },
        required: ["server", "uri"],
      }),
      execute: async (_id: string, params: any) => {
        const server = byName.get(String(params?.server ?? ""));
        if (!server) {
          return toolResult(budget, 
            `unknown server "${params?.server}" — available: ${live.map((l) => l.name).join(", ")}`,
            true,
          );
        }
        try {
          const result: any = await withCallTimeout(
            server.conn.client.readResource({ uri: String(params?.uri ?? "") }),
            `${server.name}.readResource`,
          );
          const text = (result?.contents ?? [])
            .map((c: any) => c?.text ?? `[${c?.mimeType ?? "binary"} ${c?.uri ?? ""}]`)
            .join("\n");
          return toolResult(budget, text || "(empty resource)");
        } catch (e) {
          return toolResult(budget, `MCP read failed: ${(e as Error)?.message ?? String(e)}`, true);
        }
      },
    });
  }

  // --- prompts: pi templates, plus a tool for the ones that take arguments ---
  const promptTemplates: PromptTemplate[] = [];
  const promptServers = live.filter((l) => l.caps.some((c) => c.kind === "prompt"));

  if (promptServers.length) {
    tools.push({
      name: "mcp_get_prompt",
      label: "mcp_get_prompt",
      description:
        "Fetch a rendered prompt from an MCP server. Use when a prompt template tells you to, " +
        "passing the arguments it names.",
      parameters: jsonSchemaToTypebox({
        type: "object",
        properties: {
          server: { type: "string" },
          name: { type: "string" },
          arguments: { type: "object", description: "the prompt's named arguments" },
        },
        required: ["server", "name"],
      }),
      execute: async (_id: string, params: any) => {
        const server = byName.get(String(params?.server ?? ""));
        if (!server) {
          return toolResult(budget, `unknown server "${params?.server}"`, true);
        }
        try {
          const rendered = await renderPrompt(
            server.conn,
            String(params?.name ?? ""),
            (params?.arguments ?? {}) as Record<string, string>,
          );
          return toolResult(budget, rendered);
        } catch (e) {
          return toolResult(budget, `MCP prompt failed: ${(e as Error)?.message ?? String(e)}`, true);
        }
      },
    });

    for (const server of promptServers) {
      for (const cap of server.caps.filter((c) => c.kind === "prompt")) {
        const args = parsePromptArgs(cap.schemaJson);
        const name = `${server.slug}__${slugify(cap.name)}`;

        if (!args.length) {
          // No arguments means the content is fixed, so it can be fetched once
          // and used directly — no round trip at invocation time.
          try {
            const content = await renderPrompt(server.conn, cap.name, {});
            promptTemplates.push({ name, description: cap.description ?? undefined, content });
            continue;
          } catch (e) {
            logger.warn("mcp.prompt_render_failed", {
              server: server.name,
              prompt: cap.name,
              message: (e as Error)?.message,
            });
          }
        }

        // Pi templates substitute positional placeholders ($1, $2); MCP prompts
        // take named arguments. The template maps one onto the other and hands
        // the fetch to the tool above.
        const mapping = args.map((a, i) => `"${a.name}": "$${i + 1}"`).join(", ");
        const argHint = args.length
          ? `Arguments, in order: ${args.map((a) => a.name).join(", ")}.`
          : "";
        promptTemplates.push({
          name,
          description: cap.description ?? undefined,
          content:
            `Call mcp_get_prompt with server="${server.name}", name="${cap.name}", ` +
            `arguments={${mapping}}, then follow the prompt it returns. ${argHint}`.trim(),
        });
      }
    }
  }

  return {
    tools,
    promptTemplates,
    servers: outcomes,
    systemPromptBlock: buildSystemPromptBlock(live),
    dispose,
  };
}

/** MCP prompt arguments are stored as the raw JSON array the server returned. */
function parsePromptArgs(schemaJson: string | null | undefined): { name: string }[] {
  if (!schemaJson) return [];
  try {
    const parsed = JSON.parse(schemaJson);
    return Array.isArray(parsed) ? parsed.filter((a: any) => a?.name) : [];
  } catch {
    return [];
  }
}

/** Fetch a prompt and flatten its messages into the text a template holds. */
async function renderPrompt(
  conn: McpConnection,
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const result: any = await withCallTimeout(
    conn.client.getPrompt({ name, arguments: args }),
    `${conn.spec.name}.getPrompt`,
  );
  return (result?.messages ?? [])
    .map((m: any) => flattenContent([m?.content].flat()))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Name the servers and their tools in the system prompt.
 *
 * Same reasoning as the document and database blocks: a tool the model has not
 * been told about is one it will not think to call. Descriptions are left to
 * the tool definitions — this is an index, not a manual.
 */
function buildSystemPromptBlock(live: Live[]): string {
  if (!live.length) return "";
  const lines = live.map((server) => {
    const toolNames = server.caps
      .filter((c) => c.kind === "tool")
      .map((c) => `${server.slug}__${slugify(c.name)}`);
    const resourceCount = server.caps.filter((c) => c.kind === "resource").length;
    const extras = resourceCount ? ` (+${resourceCount} resource(s), via mcp_read_resource)` : "";
    return `- "${server.name}": ${toolNames.length ? toolNames.join(", ") : "no tools"}${extras}`;
  });
  return (
    `\n\nConnected MCP servers:\n${lines.join("\n")}\n` +
    `These tools reach live external systems. Prefer them over guessing, and say so when a ` +
    `call fails rather than inventing what it would have returned.`
  );
}
