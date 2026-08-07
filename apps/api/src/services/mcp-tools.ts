import type { PromptTemplate } from "@earendil-works/pi-agent-core";
import { jsonSchemaToTypebox } from "../lib/typebox-schema";
import { logger } from "../lib/logger";
import {
  mcpStore,
  type McpStore,
  type NewCapability,
} from "../repositories/mcp.repository";
import { runRepository, type ToolUsage } from "../repositories/run.repository";
import type { McpCapabilityRow } from "../models/schema";
import {
  CALL_TIMEOUT_MS,
  connectMcpServer,
  type Connector,
  type McpConnection,
  type McpServerSpec,
} from "./mcp/client";
import { listCapabilities } from "./mcp/probe";
import {
  argNamesOf,
  buildIndex,
  coreToolNames,
  searchTools,
  type ToolDoc,
} from "./mcp/tool-search";

/**
 * Every MCP server a workspace has enabled, adapted into what a pi run needs:
 * tools, prompt templates, and a system-prompt block.
 *
 * The catalog is read from `mcp_capabilities`, not from a live connection.
 * Probing is already done at add time and on refresh (`mcp.controller`), so the
 * rows are authoritative and every run was re-listing tools it already had:
 * `mcp.connect` spans measured 4.2–6.2 seconds, on every run, including runs
 * that went on to call no MCP tool at all.
 *
 * Connections are therefore opened on first *call* and live for exactly one run
 * — `dispose()` is called from the same `finally` that cleans up the execution
 * environment. A pool across runs would need health checks, reconnection, and
 * per-workspace eviction to earn its keep.
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
  /** How long connecting and listing this one server took. 0 when cached. */
  ms: number;
  /** True when the catalog came from the cache rather than a fresh probe. */
  cached: boolean;
};

export type McpRuntime = {
  /** Pi AgentTools, ready to concatenate onto the harness tool list. */
  tools: any[];
  /**
   * The subset of `tools` to hand the harness as its *active* set.
   *
   * Everything else stays registered but unloaded, costing no context until
   * `search_tools` activates it. See `mcp/tool-search.ts` for why.
   */
  activeToolNames: string[];
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
  activeToolNames: [],
  promptTemplates: [],
  servers: [],
  systemPromptBlock: "",
};

/**
 * How many previously-used tools stay loaded from the start.
 *
 * 14 tools covered 90% of every MCP call this deployment has made, so the
 * elbow is real and it is low. Set at 15 to sit just past it: high enough that
 * the common path never searches, low enough that the floor stays near 4k
 * tokens rather than the 36,512 that loading all 151 cost.
 */
export const CORE_TOOL_LIMIT = 15;

/** How many tools one `search_tools` call may load. */
export const SEARCH_RESULT_LIMIT = 5;

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

/**
 * Shortest run of encoded-looking characters treated as binary.
 *
 * 256 is well above anything prose or identifiers produce: natural text cannot
 * go 256 characters without a space, and minified code carries `{`, `;`, `.`
 * and `,`, none of which are in the alphabet below. Real payloads are far
 * larger than this — the contact photos that motivated it ran to thousands of
 * characters each — so the threshold has a wide margin on both sides.
 */
export const BINARY_RUN_MIN = 256;

/**
 * Base64 and base64url, since both show up: MCP servers embed images as data
 * URIs, and tokens use the `-_` variant.
 */
const BINARY_RUN = new RegExp(`[A-Za-z0-9+/_-]{${BINARY_RUN_MIN},}={0,2}`, "g");

/**
 * Replace embedded binary with a note saying it was there.
 *
 * A model reading text can do nothing with base64. It is pure cost, and it is
 * not a small one: `nc_contacts_list_contacts` returned a contact list that was
 * two thirds avatar photos, blew RESULT_CHAR_CAP, and came back truncated after
 * eight of the contacts. The model spent the next seven turns trying to work
 * out how many contacts existed — from WebDAV searches, directory listings, and
 * eventually `env | grep` — because the answer had been cut off behind the
 * photos.
 *
 * Elision runs before the cap, so the budget is spent on characters that carry
 * information. The marker is left in place rather than removing the run
 * silently: a model that cannot tell "there was an image here" from "this field
 * was empty" will describe a contact as having no photo.
 *
 * The replacement deliberately contains no quotes or backslashes, so a JSON
 * result stays parseable after it.
 */
export function elideBinary(text: string): string {
  return text.replace(
    BINARY_RUN,
    (match) => `[binary data, ${match.length.toLocaleString()} characters elided]`,
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
  // Binary goes first: capping before eliding would spend the whole allowance
  // on photos and truncate the fields that answer the question.
  const capped = budget.take(elideBinary(text));
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

/**
 * Late-bound handle to the harness's active tool set.
 *
 * `search_tools` has to widen the tool set of a harness that does not exist
 * yet: the tools are built first and passed to its constructor. The holder is
 * filled in immediately after construction, before any turn can run, so the
 * unbound state is unreachable in practice — but it returns an honest failure
 * rather than throwing if a caller ever forgets.
 */
export type HarnessToolSet = {
  getActiveTools(): { name: string }[];
  setActiveTools(names: string[]): Promise<void>;
};

export function createToolActivator() {
  let harness: HarnessToolSet | null = null;
  return {
    bind(h: HarnessToolSet) {
      harness = h;
    },
    /** Add `names` to the active set. Returns the ones that were not already on. */
    async activate(names: string[]): Promise<string[]> {
      if (!harness) return [];
      const current = harness.getActiveTools().map((t) => t.name);
      const added = names.filter((n) => !current.includes(n));
      if (added.length) await harness.setActiveTools([...current, ...added]);
      return added;
    },
  };
}

export type ToolActivator = ReturnType<typeof createToolActivator>;

export type McpToolsOptions = {
  /** Widens the harness's active tool set when `search_tools` finds something. */
  activator?: ToolActivator;
  /** How many previously-used tools stay loaded. 0 disables the core set. */
  coreLimit?: number;
  /** Where the "what has this workspace called" history comes from. */
  usage?: (workspaceId: string) => Promise<ToolUsage[]>;
  /** Notified when a lazy connection is opened, so a run can trace the cost. */
  onConnect?: (outcome: { server: string; ms: number; ok: boolean; error?: string }) => void;
};

/** One entry of the catalog: an MCP tool as the model will see it. */
type CatalogEntry = {
  /** The namespaced name the model calls. */
  name: string;
  serverId: string;
  serverName: string;
  /** The name the server itself knows it by. */
  remoteName: string;
  description: string;
  schemaJson: string | null;
};

export async function createMcpTools(
  workspaceId: string,
  store: McpStore = mcpStore,
  connector: Connector = connectMcpServer,
  options: McpToolsOptions = {},
): Promise<McpRuntime> {
  const {
    activator,
    coreLimit = CORE_TOOL_LIMIT,
    usage = (id: string) => runRepository.toolUsage(id),
    onConnect,
  } = options;

  const rows = await store.listEnabled(workspaceId);
  if (!rows.length) return { ...EMPTY_RUNTIME, dispose: async () => {} };

  // --- connections, opened on first call rather than up front ---
  const opened = new Map<string, Promise<McpConnection>>();

  const connect = (serverId: string): Promise<McpConnection> => {
    let pending = opened.get(serverId);
    if (pending) return pending;

    const row = rows.find((r) => r.id === serverId);
    if (!row) return Promise.reject(new Error(`unknown server ${serverId}`));

    const startedAt = Date.now();
    pending = (async () => {
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
      return connector(spec);
    })();

    // The promise is cached before it settles, failures included: a server that
    // is down should cost one connection attempt per run, not one per call.
    opened.set(serverId, pending);

    pending.then(
      async () => {
        onConnect?.({ server: row.name, ms: Date.now() - startedAt, ok: true });
        await store.markStatus(workspaceId, row.id, "connected", null).catch(() => {});
      },
      async (e: unknown) => {
        const error = (e as Error)?.message ?? String(e);
        logger.warn("mcp.connect_failed", { server: row.name, message: error });
        onConnect?.({ server: row.name, ms: Date.now() - startedAt, ok: false, error });
        await store.markStatus(workspaceId, row.id, "error", error).catch(() => {});
      },
    );

    return pending;
  };

  const dispose = async () => {
    await Promise.all(
      [...opened.values()].map((p) => p.then((c) => c.close()).catch(() => {})),
    );
  };

  // --- the catalog: cached rows first, a probe only for servers that have none ---
  const cached = await store.capabilities(workspaceId);
  const capsByServer = new Map<string, McpCapabilityRow[]>();
  for (const cap of cached) {
    const list = capsByServer.get(cap.serverId) ?? [];
    list.push(cap);
    capsByServer.set(cap.serverId, list);
  }

  const outcomes: McpServerOutcome[] = [];

  // A server with no cached catalog is invisible to the model, so it is worth a
  // connection here — this is the first run after it was added by a path that
  // never probed, or after a probe failed. Warm servers skip it entirely, which
  // is the whole point.
  const cold = rows.filter((r) => !(capsByServer.get(r.id)?.length));
  await Promise.all(
    cold.map(async (row) => {
      const startedAt = Date.now();
      try {
        const conn = await connect(row.id);
        const caps = await listCapabilities(conn);
        await store.saveCapabilities(workspaceId, row.id, caps);
        capsByServer.set(row.id, asCapabilityRows(workspaceId, row.id, caps));
      } catch (e) {
        const error = (e as Error)?.message ?? String(e);
        outcomes.push({
          name: row.name,
          transport: row.transport,
          ok: false,
          error,
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
          ms: Date.now() - startedAt,
          cached: false,
        });
      }
    }),
  );

  const failed = new Set(outcomes.map((o) => o.name));
  const live = rows
    .filter((r) => !failed.has(r.name))
    .map((r) => ({
      serverId: r.id,
      name: r.name,
      slug: slugify(r.name),
      transport: r.transport,
      caps: capsByServer.get(r.id) ?? [],
      cached: !cold.includes(r),
    }));

  for (const server of live) {
    outcomes.push({
      name: server.name,
      transport: server.transport,
      ok: true,
      toolCount: server.caps.filter((c) => c.kind === "tool").length,
      resourceCount: server.caps.filter((c) => c.kind === "resource").length,
      promptCount: server.caps.filter((c) => c.kind === "prompt").length,
      ms: 0,
      cached: server.cached,
    });
  }

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
  const catalog: CatalogEntry[] = [];
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
      catalog.push({
        name,
        serverId: server.serverId,
        serverName: server.name,
        remoteName: cap.name,
        description: cap.description ?? `The "${cap.name}" tool.`,
        schemaJson: cap.schemaJson,
      });
    }
  }

  for (const entry of catalog) {
    tools.push({
      name: entry.name,
      label: entry.name,
      description: `${entry.description} (MCP server: ${entry.serverName})`,
      parameters: jsonSchemaToTypebox(
        entry.schemaJson ? (JSON.parse(entry.schemaJson) as Record<string, unknown>) : undefined,
      ),
      execute: async (_id: string, params: any) => {
        try {
          const conn = await connect(entry.serverId);
          const result: any = await withCallTimeout(
            conn.client.callTool({ name: entry.remoteName, arguments: params ?? {} }),
            `${entry.serverName}.${entry.remoteName}`,
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

  // --- which of those start loaded, and the tool that loads the rest ---
  const catalogNames = new Set(catalog.map((c) => c.name));
  let history: ToolUsage[] = [];
  try {
    history = coreLimit > 0 ? await usage(workspaceId) : [];
  } catch (e: any) {
    // No history means an empty core set, which is a slower first turn — never
    // a failed run.
    logger.warn("mcp.usage_failed", { workspaceId, message: e?.message ?? String(e) });
  }
  const core = coreToolNames(history, catalogNames, coreLimit);

  const index = buildIndex(
    catalog.map(
      (c): ToolDoc => ({
        name: c.name,
        description: c.description,
        args: argNamesOf(c.schemaJson),
      }),
    ),
  );

  if (catalog.length > core.length) {
    tools.push({
      name: "search_tools",
      label: "search_tools",
      description:
        `Find MCP tools that are not currently loaded. ${catalog.length} tools are available ` +
        `across ${live.length} server(s), but only the most-used ones are loaded to save ` +
        `context. Search by what you want to do ("upload a file", "list calendar events") and ` +
        `the matches become callable on your NEXT step. Use this before concluding something ` +
        `cannot be done.`,
      parameters: jsonSchemaToTypebox({
        type: "object",
        properties: {
          query: { type: "string", description: "what you are trying to do, in words" },
        },
        required: ["query"],
      }),
      execute: async (_id: string, params: any) => {
        const query = String(params?.query ?? "").trim();
        if (!query) return toolResult(budget, "search_tools needs a 'query'.", true);

        const matches = searchTools(index, query, SEARCH_RESULT_LIMIT);
        if (!matches.length) {
          return toolResult(
            budget,
            `No tool matches "${query}". Loaded tools: ${core.join(", ") || "(none)"}. ` +
              `Try different words, or say the request cannot be met.`,
          );
        }

        const added = (await activator?.activate(matches.map((m) => m.name))) ?? [];
        const lines = matches.map((m) => `${m.name} — ${m.description}`);
        logger.info("mcp.tool_search", { workspaceId, query, added: added.length });

        return toolResult(
          budget,
          `${matches.length} tool(s) matched and are now loaded. They are callable on your ` +
            `next step, not this one:\n${lines.join("\n")}`,
        );
      },
    });
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
          const conn = await connect(server.serverId);
          const result: any = await withCallTimeout(
            conn.client.readResource({ uri: String(params?.uri ?? "") }),
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
          const conn = await connect(server.serverId);
          const rendered = await renderPrompt(
            conn,
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

        // Every prompt routes through `mcp_get_prompt`, including the ones that
        // take no arguments and whose content is therefore fixed. Those used to
        // be fetched once while building the runtime, which was free when a
        // connection was already open — and is a whole connection now that they
        // are not. One tool call the first time a prompt is used is the cheaper
        // half of that trade.
        //
        // Pi templates substitute positional placeholders ($1, $2); MCP prompts
        // take named arguments. The template maps one onto the other.
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

  // Everything that is not a catalog tool stays loaded: search_tools is how the
  // catalog is reached at all, and the resource/prompt helpers are a flat two
  // or three regardless of how many resources exist.
  const helpers = tools.map((t) => t.name).filter((n) => !catalogNames.has(n));
  const activeToolNames = [...core, ...helpers];

  logger.info("mcp.catalog", {
    workspaceId,
    servers: live.length,
    advertised: catalog.length,
    active: activeToolNames.length,
    core: core.length,
    probed: cold.length,
  });

  return {
    tools,
    activeToolNames,
    promptTemplates,
    servers: outcomes,
    systemPromptBlock: buildSystemPromptBlock(live, catalog, core),
    dispose,
  };
}

/**
 * The rows `saveCapabilities` just wrote, without reading them back.
 *
 * Only the fields the catalog uses are filled; `id` is not among them, and
 * inventing one that does not match the stored row would be worse than the
 * empty string it never reads.
 */
function asCapabilityRows(
  workspaceId: string,
  serverId: string,
  caps: NewCapability[],
): McpCapabilityRow[] {
  return caps.map((cap) => ({
    id: "",
    serverId,
    workspaceId,
    kind: cap.kind,
    name: cap.name,
    description: cap.description ?? null,
    schemaJson: cap.schemaJson ?? null,
    uri: cap.uri ?? null,
  }));
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
 * Name the servers in the system prompt, and say that the tool list is partial.
 *
 * This used to list all 151 namespaced tool names, which cost roughly a
 * thousand tokens of every prompt to duplicate what the tool schemas already
 * said. Now the schemas are the partial thing, so the block has one job the
 * schemas cannot do: tell the model that what it can see is not all there is,
 * and name the way to reach the rest. A model that does not know a tool exists
 * will answer from memory instead of looking for it.
 */
function buildSystemPromptBlock(
  live: { name: string; caps: McpCapabilityRow[] }[],
  catalog: CatalogEntry[],
  core: string[],
): string {
  if (!live.length) return "";

  const lines = live.map((server) => {
    const toolCount = server.caps.filter((c) => c.kind === "tool").length;
    const resourceCount = server.caps.filter((c) => c.kind === "resource").length;
    const extras = resourceCount ? `, ${resourceCount} resource(s) via mcp_read_resource` : "";
    return `- "${server.name}": ${toolCount} tool(s)${extras}`;
  });

  const hidden = catalog.length - core.length;
  // Scoped to "for that server" on purpose. Phrased as a bare "search before
  // concluding it is impossible", this sentence pushed the model toward MCP for
  // requests that were never about MCP — "ls all file in this server" listed a
  // Nextcloud share rather than the workspace.
  const partial =
    hidden > 0
      ? `\nOnly the ${core.length} tool(s) you use most often are loaded right now. The other ` +
        `${hidden} are available but not shown: when you have decided a request is about one ` +
        `of these servers, call "search_tools" with a description of what you need and the ` +
        `matches become callable on your next step. Not seeing a tool for that server does ` +
        `not mean it has none.`
      : "";

  return (
    `\n\nConnected MCP servers:\n${lines.join("\n")}${partial}\n` +
    `These are remote systems, not the machine you are running on. Use them when the request ` +
    `is about that service. They are live, so never invent what a call would have returned — ` +
    `report the failure instead.`
  );
}
