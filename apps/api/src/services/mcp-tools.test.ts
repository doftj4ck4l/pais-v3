import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteMcpStore } from "../repositories/mcp.repository";
import type { Connector, McpConnection } from "./mcp/client";
import {
  RESULT_CHAR_CAP,
  RUN_CHAR_BUDGET,
  capResult,
  createBudget,
  createMcpTools,
} from "./mcp-tools";

/**
 * Runs against a real MCP server over the SDK's in-memory transport, not a
 * stubbed client. The thing under test is a protocol adaptation — tool
 * discovery, schema conversion, result flattening — and a hand-rolled fake
 * would only assert that the adapter matches the fake.
 */

(env as { connectionSecret: string }).connectionSecret = "test-secret";

/** A server offering two tools, a resource, and two prompts. */
function githubServer() {
  const server = new Server(
    { name: "github", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search",
        description: "Search issues",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            filter: {
              type: "object",
              properties: { state: { type: "string", enum: ["open", "closed"] } },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "create_issue",
        description: "Open an issue",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
      {
        name: "dump_everything",
        description: "Returns far more than a context window holds",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "search") {
      return { content: [{ type: "text", text: `found: ${req.params.arguments?.query}` }] };
    }
    if (req.params.name === "dump_everything") {
      // A real Nextcloud `search_files` returned 239,701 characters here.
      return { content: [{ type: "text", text: "x".repeat(250_000) }] };
    }
    return { content: [{ type: "text", text: "boom" }], isError: true };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "repo://readme", name: "readme", description: "The README" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "# Hello" }],
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: "standup", description: "Daily standup" },
      {
        name: "triage",
        description: "Triage a bug",
        arguments: [{ name: "issue", description: "issue number", required: true }],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `prompt:${req.params.name}:${req.params.arguments?.issue ?? ""}`,
        },
      },
    ],
  }));

  return server;
}

/** A tools-only server: no resources, no prompts. Both lists error. */
function filesServer() {
  const server = new Server({ name: "files", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "file contents" }],
  }));
  return server;
}

/** Connect a client to an in-process server over a linked transport pair. */
async function linkedConnection(spec: any, server: Server): Promise<McpConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "salur-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    spec,
    client,
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteMcpStore(drizzle(sqlite) as any);
}

let store: SqliteMcpStore;

/** Connects "github" and "files"; every other name is unreachable. */
const connector: Connector = async (spec) => {
  if (spec.name === "github") return linkedConnection(spec, githubServer());
  if (spec.name === "files") return linkedConnection(spec, filesServer());
  throw new Error("connect ECONNREFUSED");
};

async function seed(names: string[]) {
  for (const [i, name] of names.entries()) {
    await store.create({
      id: `s${i}`,
      workspaceId: "ws1",
      name,
      transport: "http",
      url: `https://${name}.example.com/mcp`,
    });
  }
}

const byName = (tools: any[], name: string) => tools.find((t) => t.name === name);

beforeEach(() => {
  store = freshStore();
});

describe("capResult", () => {
  it("leaves a result that fits completely untouched", () => {
    expect(capResult("short")).toBe("short");
    const exact = "y".repeat(RESULT_CHAR_CAP);
    expect(capResult(exact)).toBe(exact);
  });

  it("truncates and says so, with the real numbers", () => {
    const out = capResult("z".repeat(100_000), 1_000);
    expect(out.startsWith("z".repeat(1_000))).toBe(true);
    expect(out).toContain("99,000");
    expect(out).toContain("100,000");
    expect(out).toContain("Narrow the call");
  });

  it("tells the model the output is incomplete, not merely shortened", () => {
    // Silent truncation is the actual danger: a model that cannot tell a cut
    // result from a complete one summarises a fraction as if it were the whole.
    expect(capResult("q".repeat(50), 10)).toContain("INCOMPLETE");
  });
});

describe("createBudget", () => {
  it("spends down as results are taken", () => {
    const b = createBudget(1_000);
    expect(b.remaining()).toBe(1_000);
    b.take("a".repeat(400));
    expect(b.remaining()).toBe(600);
  });

  it("bounds a RUN, not just a call — six capped reads cannot all pass", () => {
    // The exact shape that defeated the per-call cap: six parallel reads, each
    // individually within RESULT_CHAR_CAP, together far over the window.
    const b = createBudget(RUN_CHAR_BUDGET);
    const results = Array.from({ length: 6 }, () => b.take("x".repeat(100_000)));
    const total = results.reduce((n, r) => n + r.length, 0);

    // Without a run budget this would have been 6 * RESULT_CHAR_CAP = 240,000,
    // which is the number that actually broke a real run.
    expect(total).toBeLessThan(6 * RESULT_CHAR_CAP);
    // Each notice is appended after the cut, and exhausted calls still return a
    // short explanation, so the total can exceed the budget by a few hundred
    // characters. Bounded is the property that matters, not exact.
    expect(total).toBeLessThan(RUN_CHAR_BUDGET * 1.02);
    expect(b.remaining()).toBeLessThanOrEqual(0);
  });

  it("tells the model to stop rather than silently returning nothing", () => {
    const b = createBudget(100);
    b.take("y".repeat(500));
    const after = b.take("more data");
    expect(after).toContain("budget");
    expect(after).toContain("Do not retry");
  });

  it("never lets the last result overshoot the remaining budget", () => {
    const b = createBudget(1_000);
    b.take("a".repeat(900));
    const last = b.take("b".repeat(100_000));
    expect(b.remaining()).toBeLessThanOrEqual(0);
    expect(last.length).toBeLessThan(1_000);
  });
});

describe("createMcpTools", () => {
  it("returns nothing when the workspace has no servers", async () => {
    const runtime = await createMcpTools("ws1", store, connector);
    expect(runtime.tools).toHaveLength(0);
    expect(runtime.promptTemplates).toHaveLength(0);
    await runtime.dispose();
  });

  it("exposes each server's tools namespaced by server name", async () => {
    await seed(["github", "files"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const names = runtime.tools.map((t) => t.name);
    expect(names).toContain("github__search");
    expect(names).toContain("github__create_issue");
    expect(names).toContain("files__read_file");
    await runtime.dispose();
  });

  it("converts a nested MCP input schema into typebox parameters", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const search: any = byName(runtime.tools, "github__search");
    expect(search.parameters.required).toEqual(["query"]);
    expect(search.parameters.properties.query.type).toBe("string");
    expect(search.parameters.properties.filter.properties.state.anyOf.map((b: any) => b.const)).toEqual([
      "open",
      "closed",
    ]);
    await runtime.dispose();
  });

  it("executes a tool call against the server and flattens the result", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const search: any = byName(runtime.tools, "github__search");
    const result = await search.execute("call-1", { query: "crash" });
    expect(result.content[0].text).toBe("found: crash");
    await runtime.dispose();
  });

  it("caps an oversized tool result so one call cannot flood the context", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const dump: any = byName(runtime.tools, "github__dump_everything");
    const result = await dump.execute("call-big", {});
    const text = result.content[0].text as string;

    expect(text.length).toBeLessThan(RESULT_CHAR_CAP + 500);
    expect(text).toContain("truncated");
    expect(text).toContain("INCOMPLETE");
    // details must be capped too — it is what the trace records.
    expect(result.details.output.length).toBe(text.length);
    await runtime.dispose();
  });

  it("returns a tool error to the model rather than throwing", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const create: any = byName(runtime.tools, "github__create_issue");
    const result = await create.execute("call-2", { title: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
    await runtime.dispose();
  });

  it("keeps a reachable server's tools when another server is down", async () => {
    await seed(["github", "broken"]);
    const runtime = await createMcpTools("ws1", store, connector);

    expect(runtime.tools.map((t) => t.name)).toContain("github__search");
    expect(runtime.servers.find((s) => s.name === "broken")!.ok).toBe(false);
    expect(runtime.servers.find((s) => s.name === "github")!.ok).toBe(true);
    await runtime.dispose();
  });

  it("records the failure against the server row", async () => {
    await seed(["broken"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const [row] = await store.list("ws1");
    expect(row!.status).toBe("error");
    expect(row!.error).toContain("ECONNREFUSED");
    await runtime.dispose();
  });

  it("clears a previous error once the server connects again", async () => {
    await seed(["github"]);
    await store.markStatus("ws1", "s0", "error", "was down");
    const runtime = await createMcpTools("ws1", store, connector);

    const [row] = await store.list("ws1");
    expect(row!.status).toBe("connected");
    expect(row!.error).toBeNull();
    await runtime.dispose();
  });

  it("refreshes the capability cache from the live server", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const caps = await store.capabilities("ws1", "s0");
    expect(caps.filter((c) => c.kind === "tool").map((c) => c.name).sort()).toEqual([
      "create_issue",
      "dump_everything",
      "search",
    ]);
    expect(caps.filter((c) => c.kind === "resource")).toHaveLength(1);
    expect(caps.filter((c) => c.kind === "prompt")).toHaveLength(2);
    await runtime.dispose();
  });

  it("adds the resource tools only when some server has resources", async () => {
    await seed(["files"]);
    const filesOnly = await createMcpTools("ws1", store, connector);
    expect(filesOnly.tools.map((t) => t.name)).not.toContain("mcp_read_resource");
    await filesOnly.dispose();

    await store.create({
      id: "s-github",
      workspaceId: "ws1",
      name: "github",
      transport: "http",
      url: "https://github.example.com/mcp",
    });
    const withGithub = await createMcpTools("ws1", store, connector);
    expect(withGithub.tools.map((t) => t.name)).toContain("mcp_list_resources");
    expect(withGithub.tools.map((t) => t.name)).toContain("mcp_read_resource");
    await withGithub.dispose();
  });

  it("reads a resource through mcp_read_resource", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const read: any = byName(runtime.tools, "mcp_read_resource");
    const result = await read.execute("call-3", { server: "github", uri: "repo://readme" });
    expect(result.content[0].text).toContain("# Hello");
    await runtime.dispose();
  });

  it("lists resources through mcp_list_resources", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const list: any = byName(runtime.tools, "mcp_list_resources");
    const result = await list.execute("call-4", {});
    expect(result.content[0].text).toContain("repo://readme");
    await runtime.dispose();
  });

  it("exposes MCP prompts as pi prompt templates", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const names = runtime.promptTemplates.map((p) => p.name);
    expect(names).toContain("github__standup");
    expect(names).toContain("github__triage");
    await runtime.dispose();
  });

  it("pre-renders a prompt that takes no arguments", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const standup = runtime.promptTemplates.find((p) => p.name === "github__standup")!;
    expect(standup.content).toContain("prompt:standup:");
    await runtime.dispose();
  });

  it("maps positional placeholders onto a prompt's named arguments", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const triage = runtime.promptTemplates.find((p) => p.name === "github__triage")!;
    expect(triage.content).toContain("mcp_get_prompt");
    expect(triage.content).toContain('"issue": "$1"');
    await runtime.dispose();
  });

  it("fetches a rendered prompt through mcp_get_prompt", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    const get: any = byName(runtime.tools, "mcp_get_prompt");
    const result = await get.execute("call-5", {
      server: "github",
      name: "triage",
      arguments: { issue: "42" },
    });
    expect(result.content[0].text).toContain("prompt:triage:42");
    await runtime.dispose();
  });

  it("ignores a disabled server", async () => {
    await seed(["github", "files"]);
    await store.setEnabled("ws1", "s1", false);
    const runtime = await createMcpTools("ws1", store, connector);

    expect(runtime.tools.map((t) => t.name)).not.toContain("files__read_file");
    await runtime.dispose();
  });

  it("slugifies a server name that is not a valid tool identifier", async () => {
    await store.create({
      id: "s0",
      workspaceId: "ws1",
      name: "github",
      transport: "http",
      url: "https://github.example.com/mcp",
    });
    const runtime = await createMcpTools("ws1", store, connector);
    // The connector keys off the stored name; the tool name is the slug of it.
    expect(runtime.tools.map((t) => t.name)).toContain("github__search");
    await runtime.dispose();
  });

  it("builds a system-prompt block naming each server and its tools", async () => {
    await seed(["github"]);
    const runtime = await createMcpTools("ws1", store, connector);

    expect(runtime.systemPromptBlock).toContain("github");
    expect(runtime.systemPromptBlock).toContain("github__search");
    await runtime.dispose();
  });
});
