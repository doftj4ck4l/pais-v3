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
import { createMcpTools, type McpRuntime } from "./mcp-tools";
import { usableWindow } from "./context-window.service";
import { jsonSchemaToTypebox } from "../lib/typebox-schema";
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
    workspaceId = "default",
  } = opts;

  const key = effectiveApiKey(model);
  if (!key) throw new Error(`No API key for ${model.id} (${model.apiKeyEnv})`);

  // The same denominator the pre-run estimate uses, so the meter does not jump
  // when it switches from estimate to provider-reported.
  const usableTokens = usableWindow(model.contextWindow);

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

  // --- the agent's world: this host, or the workspace's container ---
  // `docker` isolates the run and gives the user a workspace that outlives the
  // container. `node` keeps tools on the API host and is the default, so this
  // stays inert until SANDBOX_BACKEND is switched.
  let execEnv: ExecutionEnv;
  let releaseSandbox: (() => Promise<void>) | undefined;

  if (appEnv.sandboxBackend === "docker") {
    // Timed because a cold acquire pulls an image and starts a container, which
    // is seconds; a warm one is milliseconds. On the timeline the difference
    // between those two is the whole explanation for a slow first run.
    const sandboxTimer = startTimer();
    const sandbox = await sandboxService.acquire(workspaceId);
    emit({
      type: "trace",
      step: "sandbox.acquire",
      fields: { ms: sandboxTimer.elapsed(), container: sandbox.containerId.slice(0, 12) },
    });
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
    parameters: jsonSchemaToTypebox(tool.parameters),
    label: tool.name,
    execute: async (_id: string, params: any) => {
      const out = await runTool(tool.name, params ?? {});
      return { content: [{ type: "text" as const, text: out }], details: { output: out } };
    },
  }));

  // --- long-term memory tools (remember/recall), scoped to the workspace ---
  for (const mt of createMemoryTools(workspaceId)) {
    agentTools.push({
      name: mt.name,
      description: mt.description,
      parameters: jsonSchemaToTypebox(mt.parameters as Record<string, unknown>),
      label: mt.name,
      execute: mt.execute,
    });
  }

  // --- context layer: search the user's uploaded documents ---
  for (const dt of createDocumentTools(workspaceId)) {
    agentTools.push({
      name: dt.name,
      description: dt.description,
      parameters: jsonSchemaToTypebox(dt.parameters as Record<string, unknown>),
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
        parameters: jsonSchemaToTypebox(dbt.parameters as Record<string, unknown>),
        label: dbt.name,
        execute: dbt.execute,
      });
    }
  }

  // --- MCP: whatever servers this workspace has enabled ---
  // Not gated behind `harnessTools`, unlike `db`. A workspace only has an MCP
  // server because someone added it, so the opt-in has already happened; a
  // second gate would mean adding a server and seeing nothing change.
  //
  // This connects, so it can be slow and it can fail. `createMcpTools` swallows
  // per-server failures itself; the try/catch is for the store being
  // unreachable, which must not take the run with it.
  let mcp: McpRuntime | undefined;
  const mcpTimer = startTimer();
  try {
    mcp = await createMcpTools(workspaceId);
    // Spawning a stdio server and listing its tools costs seconds on every
    // run. Untimed, that time was simply missing from the timeline.
    emit({
      type: "trace",
      step: "mcp.connect",
      fields: {
        ms: mcpTimer.elapsed(),
        servers: mcp.servers.map((sv) => sv.name).join(", ") || "(none)",
        connected: mcp.servers.filter((sv) => sv.ok).length,
        failed: mcp.servers.filter((sv) => !sv.ok).length,
        ok: mcp.servers.every((sv) => sv.ok),
        toolsExposed: mcp.tools.length,
      },
    });
    // One span per server as well. They connect in parallel, so the aggregate
    // above is the slowest of them, not the sum — and it cannot say which.
    for (const sv of mcp.servers) {
      emit({
        type: "trace",
        step: "mcp.server",
        fields: {
          name: sv.name,
          ms: sv.ms,
          transport: sv.transport,
          ok: sv.ok,
          tools: sv.toolCount,
          resources: sv.resourceCount,
          prompts: sv.promptCount,
          ...(sv.error ? { error: sv.error } : {}),
        },
      });
    }
    for (const outcome of mcp.servers) {
      if (!outcome.ok) {
        emit({
          type: "trace",
          step: "mcp",
          fields: { server: outcome.name, ok: false, error: outcome.error },
        });
      }
    }
    if (mcp.tools.length) {
      logger.info("mcp.ready", {
        run: runId,
        servers: mcp.servers.filter((s) => s.ok).length,
        tools: mcp.tools.length,
      });
    }
    agentTools.push(...mcp.tools);
  } catch (e: any) {
    logger.warn("mcp.load_failed", { run: runId, message: e?.message ?? String(e) });
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
  // MCP prompts join the same list. Appended rather than prepended so a local
  // template always wins a name collision — the repo's own prompts should not
  // be replaceable by whatever a third-party server decides to call itself.
  if (mcp?.promptTemplates.length) {
    const localNames = new Set(promptTemplates.map((p: any) => p.name));
    promptTemplates = [
      ...promptTemplates,
      ...mcp.promptTemplates.filter((p) => !localNames.has(p.name)),
    ];
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
    if (mcp?.systemPromptBlock) out += mcp.systemPromptBlock;
    if (skillsPrompt)
      out += `\n\nThe following skills are available. Invoke them via the "call_skill" tool when they'd help, instead of guessing or fetching by hand:\n${skillsPrompt}`;
    return out;
  };

  // --- the real pi AgentHarness (sessions, skills, templates, built-in tools) ---
  // Tool start times, keyed by call id so parallel calls do not overwrite
  // each other. Entries are removed as each call ends.
  const toolStartedAt = new Map<string, number>();
  const toolArgs = new Map<string, string>();

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

  // --- provider round trip ---
  //
  // The two halves arrive on DIFFERENT channels, which is the trap here:
  // `before_provider_request` goes to handlers registered with `on()` (it can
  // rewrite the request, so it needs a return value), while
  // `after_provider_response` is broadcast through `emitOwn` and therefore
  // reaches `subscribe()` instead. Registering both on one channel silently
  // yields nothing — verified the hard way.
  //
  // Each fires once per turn, wrapping the provider call, so together they
  // measure the round trip but cannot see the retries pi-ai performs inside
  // it. That gap is upstream: pi-ai defines RetryCallbacks, and the harness
  // wires them only to compaction and branch summarisation, never to the turn.
  let providerStartedAt = 0;
  harness.on("before_provider_request", () => {
    providerStartedAt = Date.now();
    return undefined;
  });

  if (signal) {
    signal.addEventListener("abort", () => harness.abort().catch(() => {}), { once: true });
  }

  let turns = 0;
  // Assistant text actually streamed to the user, and the biggest single tool
  // result of the run. Both exist for the completion check below: a run that
  // ends with zero answer needs to say why, and the largest tool result is
  // almost always the reason.
  let answerChars = 0;
  let largestToolResult = { name: "", chars: 0 };
  /** Provider-reported prompt size of the most recent turn. 0 until one lands. */
  let realTokens = 0;
  /** When the turn in flight began, so `llm.turn` can be measured. */
  let turnStartedAt = 0;
  /** Tool calls and failures across the run, for the run summary. */
  let toolCalls = 0;
  let toolErrors = 0;

  harness.subscribe((event: AgentHarnessEvent) => {
    try {
      switch (event.type) {
        case "turn_start":
          turns++;
          turnStartedAt = Date.now();
          emit({ type: "iteration", iteration: turns });
          break;
        case "turn_end": {
          // The real size of the context, straight from the provider.
          //
          // The pre-run estimate in `context-budget.service` measures the chat
          // history and nothing else — not the system prompt, not the tool
          // schemas. With 151 MCP tools advertised, the schemas alone dwarf the
          // history, which is why the meter sat at 1% while the window was
          // genuinely filling. `usage.input` is what was actually charged.
          //
          // cacheRead is added because a cached prompt prefix still occupies
          // the window; it is only cheaper, not smaller.
          // The turn as a span. Most of a run's wall clock is the model
          // thinking, so without this the timeline showed a second of tools
          // inside a nine-second run and explained none of the rest.
          const turnUsage = (event.message as any)?.usage;
          if (turnStartedAt) {
            emit({
              type: "trace",
              step: "llm.turn",
              fields: {
                ms: Date.now() - turnStartedAt,
                turn: turns,
                toolCalls: (event.toolResults ?? []).length,
                // >1 means the provider request failed and was retried.
                // Per-turn cost. `context.usage` reports the same prompt size
                // but as a context meter; here it is attached to the span that
                // actually paid for it.
                //
                // The split matters and is easy to misread: `input` is only the
                // *uncached* tokens. With 151 MCP tool schemas the gateway
                // caches the prefix, so a turn reads as 160 prompt tokens while
                // genuinely occupying 36,512. `contextTokens` is the honest
                // total, and the one the window is measured against.
                contextTokens:
                  Number(turnUsage?.input ?? 0) + Number(turnUsage?.cacheRead ?? 0),
                promptTokensUncached: Number(turnUsage?.input ?? 0),
                cachedTokens: Number(turnUsage?.cacheRead ?? 0),
                completionTokens: Number(turnUsage?.output ?? 0),
                reasoningTokens: Number(turnUsage?.reasoning ?? 0),
                stopReason: String((event.message as any)?.stopReason ?? ""),
                answer: preview(assistantTextOf(event.message), ANSWER_PREVIEW_CHARS),
              },
            });
            turnStartedAt = 0;
          }

          const usage = turnUsage;
          const input = Number(usage?.input ?? 0) + Number(usage?.cacheRead ?? 0);
          if (input > 0) {
            realTokens = input;
            emit({ type: "context", used: input, window: usableTokens, estimated: false });
            // Recorded as well as emitted: the next request needs to know what
            // this one actually cost to decide whether to compact, and the
            // transcript is where that survives.
            emit({
              type: "trace",
              step: "context.usage",
              fields: { used: input, window: usableTokens, output: Number(usage?.output ?? 0) },
            });
          }
          break;
        }
        case "message_update": {
          const a = event.assistantMessageEvent;
          if (a.type === "thinking_delta") emit({ type: "reasoning", delta: a.delta });
          else if (a.type === "text_delta") {
            answerChars += a.delta.length;
            emit({ type: "text", delta: a.delta });
          }
          break;
        }
        case "tool_execution_start":
          // Started-at is kept per call id, not per tool name: tools run in
          // parallel, so two calls to the same tool are in flight at once.
          toolStartedAt.set(event.toolCallId, Date.now());
          // Arguments are only on the start event, but they are wanted on the
          // span, which is written at the end. Held per call id for the same
          // reason the start time is: parallel calls to one tool overlap.
          toolArgs.set(event.toolCallId, previewArgs(event.args));
          logger.info("tool", { run: runId, name: event.toolName, args: event.args });
          emit({ type: "tool_call", id: event.toolCallId, name: event.toolName, args: event.args ?? {} });
          break;
        case "tool_execution_end": {
          const text = extractResultText(event.result);
          const startedAt = toolStartedAt.get(event.toolCallId);
          const args = toolArgs.get(event.toolCallId) ?? "{}";
          toolStartedAt.delete(event.toolCallId);
          toolArgs.delete(event.toolCallId);
          const ms = startedAt === undefined ? undefined : Date.now() - startedAt;
          const failed = event.isError === true;

          toolCalls++;
          if (failed) toolErrors++;

          if (text.length > largestToolResult.chars) {
            largestToolResult = { name: event.toolName, chars: text.length };
          }

          logger.info("tool.end", {
            run: runId,
            name: event.toolName,
            ms,
            ok: !failed,
            chars: text.length,
          });
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
          //
          // Arguments are carried here as well, truncated. Without them a slow
          // span says "nc_webdav_search_files took 14s" and leaves you guessing
          // which search that was, which is exactly the question the timeline
          // exists to answer. Results are not: they run to hundreds of KB and
          // already live in the transcript.
          emit({
            type: "trace",
            step: "tool",
            fields: {
              name: event.toolName,
              ms,
              ok: !failed,
              args,
              resultChars: text.length,
              result: preview(text, RESULT_PREVIEW_CHARS),
            },
          });
          break;
        }
        // #4: surface slots/persona info (active tool set + queue modes) to the UI
        // Retries pi reports explicitly. These cover compaction and branch
        // summarisation only; a retried *turn* shows up as providerRequests > 1
        // above, which is why both are recorded.
        case "retry_scheduled":
          emit({
            type: "trace",
            step: "retry.scheduled",
            fields: {
              operation: event.operation,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              error: event.errorMessage,
              ok: false,
            },
          });
          logger.warn("retry.scheduled", {
            run: runId,
            operation: event.operation,
            attempt: event.attempt,
            error: event.errorMessage,
          });
          break;

        case "retry_finished":
          emit({
            type: "trace",
            step: "retry.finished",
            fields: { operation: event.operation },
          });
          break;

        // The closing half of the provider round trip. See the `on()`
        // registration above for why this half lives here instead.
        case "after_provider_response": {
          if (providerStartedAt) {
            const headers = (event as any)?.headers ?? {};
            emit({
              type: "trace",
              step: "provider.request",
              fields: {
                ms: Date.now() - providerStartedAt,
                // Rate-limit and request-id headers explain a slow turn that
                // no other span can account for.
                requestId: String(headers["x-request-id"] ?? ""),
                rateRemaining: String(headers["x-ratelimit-remaining-requests"] ?? ""),
              },
            });
            providerStartedAt = 0;
          }
          break;
        }

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

    // A run that ends without a single character of answer is the one failure
    // mode that looks identical to success from the outside: the harness
    // reports idle, `done` fires, and the console is left showing the last
    // step forever. It is not hypothetical — a 239,701-character MCP tool
    // result filled the window and the following turn had nothing left to
    // answer in. Name it, and name the likeliest cause, rather than emitting a
    // silent `done`.
    if (answerChars === 0) {
      const culprit =
        largestToolResult.chars > 20_000
          ? ` The largest tool result was "${largestToolResult.name}" at ` +
            `${largestToolResult.chars.toLocaleString()} characters, which likely filled the ` +
            `context window. Ask for something narrower.`
          : "";
      logger.warn("run.empty", {
        run: runId,
        turns,
        largestTool: largestToolResult.name,
        largestChars: largestToolResult.chars,
      });
      emit({
        type: "error",
        message: `The model finished without producing an answer.${culprit}`,
      });
    }

    // Recorded as a span so the run list can show "3 of 12 tool calls failed"
    // without re-reading every span for every row.
    emit({
      type: "trace",
      step: "run.tools",
      fields: { toolCalls, toolErrors, ok: toolErrors === 0 },
    });

    logger.info("run.end", {
      run: runId,
      ms: t.elapsed(),
      turns,
      answerChars,
      toolCalls,
      toolErrors,
      // The real window occupancy at the end of the run. Logged because it is
      // the number that decides whether the NEXT request has to compact.
      contextTokens: realTokens,
      contextPct: usableTokens ? Math.round((realTokens / usableTokens) * 100) : 0,
    });
    emit({ type: "done", turns });
  } catch (e) {
    logger.warn("run.error", { run: runId, ms: t.elapsed(), error: (e as Error)?.message });
    emit({ type: "error", message: (e as Error)?.message ?? String(e) });
  } finally {
    // MCP connections are per-run. Closed here, alongside the execution
    // environment, so a stdio server's child process cannot outlive the run
    // that spawned it.
    await mcp?.dispose().catch(() => {});
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

// The JSON-Schema -> typebox conversion moved to lib/typebox-schema.ts when MCP
// arrived: server-published schemas nest, and the version that lived here
// flattened anything below the top level to Type.Any().

/** How much of a tool's arguments a span carries. */
const ARGS_PREVIEW_CHARS = 600;

/**
 * How much of a tool's output a span carries.
 *
 * The whole output already lives in the transcript; this copy exists so the
 * timeline can answer "what did that call actually return" without leaving the
 * page. Bounded because MCP results reach tens of thousands of characters and
 * the traces table is not an archive.
 */
const RESULT_PREVIEW_CHARS = 2_000;

/** How much of a turn's answer text a span carries. */
const ANSWER_PREVIEW_CHARS = 1_000;

/** Truncate for storage, saying so rather than trailing off silently. */
function preview(text: string, cap: number): string {
  const value = text ?? "";
  return value.length > cap
    ? `${value.slice(0, cap)}… (${value.length.toLocaleString()} chars total)`
    : value;
}

/** The visible answer text of an assistant message, ignoring tool calls. */
function assistantTextOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("");
}

/**
 * A readable, bounded copy of a tool call's arguments.
 *
 * Bounded because an argument can be a whole file: `write` takes its content
 * as a parameter, and storing that verbatim would put megabytes into the trace
 * table to answer a question about timing.
 */
function previewArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > ARGS_PREVIEW_CHARS
      ? `${json.slice(0, ARGS_PREVIEW_CHARS)}… (${json.length.toLocaleString()} chars)`
      : json;
  } catch {
    // Circular or otherwise unserialisable. The span is still worth keeping.
    return "(unserialisable)";
  }
}
