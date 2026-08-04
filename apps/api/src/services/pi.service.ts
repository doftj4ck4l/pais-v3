import {
  createModels,
  createProvider,
  Type,
  type TSchema,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  AgentHarness,
  InMemorySessionStorage,
  Session,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  loadPromptTemplates,
  type AgentHarnessEvent,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { env as appEnv } from "../config/env";
import { DockerExecutionEnv } from "./sandbox/docker-execution-env";
import { sandboxService } from "./sandbox/sandbox.service";
import path from "node:path";
import fs from "node:fs";
import type { AgentEvent } from "../types/agent";
import type { ModelConfig } from "../catalog/llm-models";
import { effectiveApiKey } from "../catalog/llm-models";
import type { ChatMessage } from "../types/chat";
import { TOOLS, runTool } from "../catalog/tools";
import { getSkills, skillsBlock, invokeSkill } from "./skill.service";
import { createMemoryTools } from "./memory.service";
import { createDocumentTools } from "./context-tools";
import { documentStore } from "../repositories/document.repository";
import { createDatabaseTools } from "./db-tools";
import { databaseConnectionStore } from "../repositories/database-connection.repository";
import { logger, startTimer } from "../lib/logger";

type Emit = (event: AgentEvent) => void;

/**
 * Drive the REAL pi agent runtime (earendil-works/pi) in-process, pointed at an
 * OpenAI-compatible model (our local qwen gateway). This replaces the fake
 * text-prompt "harness" with the actual pi Agent loop + real tool execution.
 */
export async function runPiAgent(opts: {
  model: ModelConfig;
  systemPrompt: string;
  /** Capability gates from the harness (e.g. "db"). Empty for harnesses that named none. */
  harnessTools?: string[];
  history: ChatMessage[];
  emit: Emit;
  signal?: AbortSignal;
  runId?: string;
  template?: { name: string; args?: string[] };
  workspace?: string;
  userId?: string;
  workspaceId?: string;
}): Promise<number> {
  const {
    model,
    systemPrompt,
    harnessTools = [],
    history,
    emit,
    signal,
    runId = "-",
    template,
    workspace,
    userId = "default",
    workspaceId = userId,
  } = opts;

  const key = effectiveApiKey(model);
  if (!key) throw new Error(`No API key for ${model.id} (${model.apiKeyEnv})`);

  // --- pi-ai: register the gateway as a custom OpenAI-compatible provider ---
  const reasoning = model.provider === "custom" && !model.model.toLowerCase().includes("-instruct");
  const piModel: TSchema extends never ? never : any = {
    id: model.model, // bare model id, e.g. "qwen3.5-397b-instruct"
    name: model.label,
    api: "openai-completions",
    provider: "gw",
    baseUrl: model.baseUrl.replace(/\/+$/, ""),
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: "gw",
      baseUrl: model.baseUrl.replace(/\/+$/, ""),
      auth: {
        apiKey: {
          name: "gateway api key",
          async resolve() {
            return key ? { auth: { apiKey: key }, source: "runtime-api" } : undefined;
          },
        },
      },
      models: [piModel],
      api: openAICompletionsApi(),
    }),
  );

  const m = models.getModel("gw", model.model);
  if (!m) throw new Error(`model not found: ${model.model}`);

  // --- the agent's world: this host, or a per-user container ---
  // `docker` isolates the run and gives the user a workspace that outlives the
  // container. `node` keeps tools on the API host and is the default, so this
  // stays inert until SANDBOX_BACKEND is switched.
  let execEnv: ExecutionEnv;
  let releaseSandbox: (() => Promise<void>) | undefined;

  if (appEnv.sandboxBackend === "docker") {
    const sandbox = await sandboxService.acquire(workspaceId);
    execEnv = new DockerExecutionEnv({
      containerId: sandbox.containerId,
      cwd: sandbox.workspacePath,
    });
    releaseSandbox = () => sandboxService.release(workspaceId);
  } else {
    const workspaceDir = workspace ?? path.resolve(process.cwd(), "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    execEnv = new NodeExecutionEnv({ cwd: workspaceDir });
  }

  // --- built-in pi tools: bash + file read/write/edit (scoped to workspace) ---
  const builtinTools: any[] = [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
  ];

  // --- our custom tools convert into pi AgentTools (typebox schemas) ---
  const agentTools: any[] = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: JSON_SCHEMA_TO_TYPEBOX(tool.parameters),
    label: tool.name,
    execute: async (_id: string, params: any) => {
      const out = await runTool(tool.name, params ?? {});
      return { content: [{ type: "text" as const, text: out }], details: { output: out } };
    },
  }));

  // --- long-term memory tools (remember/recall), scoped per user ---
  for (const mt of createMemoryTools(workspaceId)) {
    agentTools.push({
      name: mt.name,
      description: mt.description,
      parameters: JSON_SCHEMA_TO_TYPEBOX(mt.parameters as Record<string, unknown>),
      label: mt.name,
      execute: mt.execute,
    });
  }

  // --- context layer: search the user's uploaded documents ---
  for (const dt of createDocumentTools(workspaceId)) {
    agentTools.push({
      name: dt.name,
      description: dt.description,
      parameters: JSON_SCHEMA_TO_TYPEBOX(dt.parameters as Record<string, unknown>),
      label: dt.name,
      execute: dt.execute,
    });
  }

  // --- context layer: read-only database access, only where a harness asks ---
  // Gated rather than always-on: the inventory prompt and three extra tools are
  // dead weight on a run that will never touch a database.
  if (harnessTools.includes("db")) {
    for (const dbt of createDatabaseTools(workspaceId)) {
      agentTools.push({
        name: dbt.name,
        description: dbt.description,
        parameters: JSON_SCHEMA_TO_TYPEBOX(dbt.parameters as Record<string, unknown>),
        label: dbt.name,
        execute: dbt.execute,
      });
    }
  }

  // --- pi-native skills (SKILL.md) loaded from apps/api/skills ---
  const { skills } = await getSkills();
  agentTools.push({
    name: "call_skill",
    description:
      "Invoke a loaded skill by running its command. Skills available: " +
      skills.map((s) => s.name).join(", ") +
      ". Pass the query or URL as 'query'.",
    parameters: Type.Object({
      skill: Type.String(),
      query: Type.String(),
    }),
    label: "call_skill",
    execute: async (_id: string, params: any) => {
      const out = await invokeSkill(String(params?.skill ?? ""), String(params?.query ?? ""), execEnv);
      return { content: [{ type: "text" as const, text: out }], details: { output: out } };
    },
  });

  // --- prompt templates loaded from apps/api/prompts/*.md ---
  const promptsDir = path.resolve(process.cwd(), "prompts");
  let promptTemplates: any[] = [];
  if (fs.existsSync(promptsDir)) {
    const loaded = await loadPromptTemplates(execEnv, promptsDir);
    promptTemplates = loaded.promptTemplates;
  }

  const skillsPrompt = await skillsBlock();

  // Naming the corpus up front is what turns search_docs from a tool the model
  // *could* call into one it knows is worth calling. Listed only when something
  // is actually indexed — advertising an empty corpus invites fruitless searches.
  let docsPrompt = "";
  try {
    const indexed = (await documentStore.list(workspaceId)).filter((d) => d.status === "indexed");
    if (indexed.length) {
      docsPrompt =
        `\n\nThe user has uploaded ${indexed.length} document(s) you can search with the ` +
        `"search_docs" tool: ${indexed.map((d) => `${d.title} (${d.pages}p)`).join(", ")}.\n` +
        `When a question could be answered from them, search before answering, and cite the ` +
        `passages you used as [file p.N]. If a search returns nothing useful, try different ` +
        `wording before falling back on your own knowledge — and say so when you do.\n` +
        `These documents are indexed passages, not files in your workspace: reach them only ` +
        `through "search_docs". Do not try to open them with the read tool.`;
    }
  } catch (e: any) {
    logger.warn("context.list_failed", { workspaceId, message: e?.message ?? String(e) });
  }

  // Table names, not table structures. Naming the corpus is what turns the
  // schema tools from ones the model *could* call into ones it knows are worth
  // calling; loading full structure here would not survive a real schema.
  let dbPrompt = "";
  if (harnessTools.includes("db")) {
    try {
      const inventory = await databaseConnectionStore.inventory(workspaceId);
      if (inventory.length) {
        dbPrompt =
          `\n\nConnected databases:\n` +
          inventory
            .map(
              (c) =>
                `- "${c.name}" — ${c.tableCount} table(s): ` +
                (c.tables.length > 60
                  ? `${c.tables.slice(0, 60).join(", ")}, … (${c.tables.length - 60} more — use search_schema)`
                  : c.tables.join(", ")),
            )
            .join("\n") +
          `\nThese are table names only. Call "describe_table" for columns and foreign keys ` +
          `before writing SQL against any of them.`;
      } else {
        dbPrompt =
          `\n\nNo databases are connected yet. Say so if the user asks you to query one.`;
      }
    } catch (e: any) {
      logger.warn("db.inventory_failed", { workspaceId, message: e?.message ?? String(e) });
    }
  }

  // #2: systemPrompt as a function that adapts to the active tool set/model.
  const systemPromptFn = (ctx: any): string => {
    const activeTools = (ctx?.activeTools ?? []).map((t: any) => t.name).join(", ");
    let out = systemPrompt;
    if (activeTools) out += `\n\nAvailable tools: ${activeTools}.`;
    if (docsPrompt) out += docsPrompt;
    if (dbPrompt) out += dbPrompt;
    if (skillsPrompt)
      out += `\n\nThe following skills are available. Invoke them via the "call_skill" tool when they'd help, instead of guessing or fetching by hand:\n${skillsPrompt}`;
    return out;
  };

  // --- the real pi AgentHarness (sessions, skills, templates, built-in tools) ---
  // Tool start times, keyed by call id so parallel calls do not overwrite
  // each other. Entries are removed as each call ends.
  const toolStartedAt = new Map<string, number>();

  const session = new Session(new InMemorySessionStorage());
  const harness = new AgentHarness({
    session,
    models,
    model: m,
    thinkingLevel: reasoning ? "high" : ("off" as any),
    systemPrompt: systemPromptFn,
    resources: { skills, promptTemplates },
    toolContext: { env: execEnv },
    tools: [...builtinTools, ...agentTools],
  });

  if (signal) {
    signal.addEventListener("abort", () => harness.abort().catch(() => {}), { once: true });
  }

  let turns = 0;
  harness.subscribe((event: AgentHarnessEvent) => {
    try {
      switch (event.type) {
        case "turn_start":
          turns++;
          emit({ type: "iteration", iteration: turns });
          break;
        case "message_update": {
          const a = event.assistantMessageEvent;
          if (a.type === "thinking_delta") emit({ type: "reasoning", delta: a.delta });
          else if (a.type === "text_delta") emit({ type: "text", delta: a.delta });
          break;
        }
        case "tool_execution_start":
          // Started-at is kept per call id, not per tool name: tools run in
          // parallel, so two calls to the same tool are in flight at once.
          toolStartedAt.set(event.toolCallId, Date.now());
          logger.info("tool", { run: runId, name: event.toolName, args: event.args });
          emit({ type: "tool_call", id: event.toolCallId, name: event.toolName, args: event.args ?? {} });
          break;
        case "tool_execution_end": {
          const text = extractResultText(event.result);
          const startedAt = toolStartedAt.get(event.toolCallId);
          toolStartedAt.delete(event.toolCallId);
          const ms = startedAt === undefined ? undefined : Date.now() - startedAt;
          const failed = event.isError === true;

          logger.info("tool.end", { run: runId, name: event.toolName, ms, ok: !failed });
          emit({
            type: "tool_result",
            name: event.toolName,
            content: text,
            calls: 1,
            ms,
            ok: !failed,
          });
          // Recorded as a trace too, so per-tool cost and failures survive the
          // run and can be queried later — the transcript keeps only the text.
          emit({
            type: "trace",
            step: "tool",
            fields: { name: event.toolName, ms, ok: !failed },
          });
          break;
        }
        // #4: surface slots/persona info (active tool set + queue modes) to the UI
        case "tools_update":
          emit({ type: "slots", mode: "tools", tools: event.activeToolNames ?? [] });
          break;
        case "queue_update":
          emit({
            type: "slots",
            mode: "queue",
            steer: event.steer?.length ?? 0,
            followUp: event.followUp?.length ?? 0,
          });
          break;
        default:
          break;
      }
    } catch (e) {
      logger.warn("pi.emit", { run: runId, error: (e as Error).message });
    }
  });

  const t = startTimer();

  emit({
    type: "slots",
    mode: "tools",
    tools: [...builtinTools, ...agentTools].map((tool) => tool.name),
  });

  try {
    if (template) {
      // Seed ALL history as persona/context; the template becomes the instruction.
      for (const m of history) {
        const pm = toPiMessage(m);
        if (pm) await session.appendMessage(pm);
      }
      await harness.promptFromTemplate(template.name, template.args ?? []);
    } else {
      // Seed prior turns, then prompt the current (last) user message.
      const last = history[history.length - 1];
      const hasUserLast = !!last && last.role === "user";
      const seed = hasUserLast ? history.slice(0, -1) : history;
      for (const m of seed) {
        const pm = toPiMessage(m);
        if (pm) await session.appendMessage(pm);
      }
      await harness.prompt(hasUserLast ? last.content ?? "" : "");
    }
    await harness.waitForIdle();
    logger.info("run.end", { run: runId, ms: t.elapsed(), turns });
    emit({ type: "done", turns });
  } catch (e) {
    logger.warn("run.error", { run: runId, ms: t.elapsed(), error: (e as Error)?.message });
    emit({ type: "error", message: (e as Error)?.message ?? String(e) });
  } finally {
    await execEnv.cleanup().catch(() => {});
    await releaseSandbox?.().catch(() => {});
  }
  return turns;
}

/** Convert our UI ChatMessage[] into pi Message[]. */
function toPiMessage(m: ChatMessage): any {
  const now = Date.now();
  if (m.role === "user") {
    return { role: "user", content: m.content ?? "", timestamp: now };
  }
  if (m.role === "assistant") {
    const content: any[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = { raw: tc.function.arguments };
      }
      content.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: args });
    }
    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "gw",
      model: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop",
      timestamp: now,
    };
  }
  if (m.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: m.tool_call_id ?? "call_x",
      toolName: m.name ?? "tool",
      content: [{ type: "text", text: m.content ?? "" }],
      isError: false,
      timestamp: now,
    };
  }
  return undefined;
}

/** Flatten a pi tool result (content blocks) into a single string for the UI. */
function extractResultText(result: any): string {
  try {
    const blocks = result?.content ?? [];
    return blocks
      .map((b: any) => (b?.type === "text" || b?.type === "thinking" ? (b.text ?? b.thinking ?? "") : ""))
      .join("\n");
  } catch {
    return String(result ?? "");
  }
}

/** Convert a JSON-Schema-ish parameters object into an equivalent typebox schema. */
function JSON_SCHEMA_TO_TYPEBOX(parameters: Record<string, unknown>): TSchema {
  const required = new Set((parameters.required as string[]) ?? []);
  const props: Record<string, TSchema> = {};
  for (const [k, v] of Object.entries((parameters.properties ?? {}) as Record<string, any>)) {
    props[k] = jsonTypeToTypebox(v);
    if (!required.has(k)) props[k] = Type.Optional(props[k]);
  }
  return Type.Object(props);
}

function jsonTypeToTypebox(s: any): TSchema {
  switch (s?.type) {
    case "string":
      return s.enum ? Type.Union(s.enum.map((e: string) => Type.Literal(e))) : Type.String();
    case "number":
      return Type.Number();
    case "integer":
      return Type.Integer();
    case "boolean":
      return Type.Boolean();
    case "array":
      return Type.Array(jsonTypeToTypebox(s.items ?? { type: "string" }));
    default:
      return Type.Any();
  }
}
