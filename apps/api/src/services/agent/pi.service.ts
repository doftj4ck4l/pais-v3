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
import { env as appEnv } from "../../config/env";
import { DockerExecutionEnv } from "../sandbox/docker-execution-env";
import { sandboxService } from "../sandbox/sandbox.service";
import path from "node:path";
import fs from "node:fs";
import type { AgentEvent } from "../../types/agent";
import type { ModelConfig } from "../../catalog/llm-models";
import { effectiveApiKey } from "../../catalog/llm-models";
import type { ChatMessage } from "../../types/chat";
import { TOOLS, runTool } from "../../catalog/tools";
import { getSkills, skillsBlock, invokeSkill } from "../skills/skill.service";
import { createMemoryTools } from "../memory/memory.service";
import { createDocumentTools } from "../documents/document-tools";
import { createImageTools } from "../media/image-tools";
import { createShareTools } from "../media/share-tools";
import { createVisionTools } from "../media/vision-tools";
import { visionConfigured } from "../media/vision.service";
import { mediaConfigured } from "../media/media.service";
import { documentStore } from "../../repositories/document.repository";
import { createDatabaseTools } from "../db/db-tools";
import { createCalendarTools } from "../connectors/calendar-tools";
import {
  APPROVAL_OPTIONS,
  approvalGranted,
  createAskUserTool,
  createUserInputRequester,
} from "./ask-user-tool";
import { connectorStore } from "../../repositories/connector.repository";
import { databaseConnectionStore } from "../../repositories/database-connection.repository";
import { createMcpTools, createToolActivator, type McpRuntime } from "../mcp/mcp-tools";
import { playbookStore } from "../../repositories/playbook.repository";
import { renderPlaybook } from "../playbook/prompt";
import { reflect } from "../playbook/reflector";
import type { ToolCallRecord } from "../playbook/signals";
import { describeEnvironment } from "./environment-prompt";
import { usableWindow } from "../context/context-window.service";
import { jsonSchemaToTypebox } from "../../lib/typebox-schema";
import { logger, startTimer } from "../../lib/logger";

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
  /** Stamped onto anything the run stores, so the console can group by session. */
  conversationId?: string;
  /** Chosen effort for a thinking model; falls back to the model's default. */
  reasoningEffort?: string;
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
    conversationId,
    reasoningEffort,
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
  /** Where the file and shell tools resolve paths, for the prompt to name. */
  let execCwd: string;

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
    execCwd = sandbox.workspacePath;
  } else {
    const workspaceDir = workspace ?? path.resolve(process.cwd(), "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    execEnv = new NodeExecutionEnv({ cwd: workspaceDir });
    execCwd = workspaceDir;
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

  // One queue for every way this run can pause for its human. Sharing it keeps
  // parallel MCP writes from replacing each other's approval prompt, and also
  // prevents a model-authored ask_user call from racing an enforced approval.
  const requestUserInput = conversationId
    ? createUserInputRequester(conversationId, emit)
    : undefined;

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

  // --- ask_user: pause the run to ask the human when something is ambiguous ---
  // Needs the conversationId to key the answer it waits on; a run without one
  // (there is none in normal chat) simply does not offer the tool.
  if (requestUserInput) {
    const askUser = createAskUserTool(requestUserInput);
    agentTools.push({
      name: askUser.name,
      description: askUser.description,
      parameters: jsonSchemaToTypebox(askUser.parameters as Record<string, unknown>),
      label: askUser.label,
      execute: askUser.execute,
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

  // --- image generation, when both halves of it are configured ---
  // Gated on storage as well as the key: generating an image bills immediately,
  // so a tool that can produce bytes it cannot then keep is worse than absent.
  if (appEnv.openrouterApiKey && mediaConfigured()) {
    for (const it of createImageTools(workspaceId, conversationId)) {
      agentTools.push({
        name: it.name,
        description: it.description,
        parameters: jsonSchemaToTypebox(it.parameters as Record<string, unknown>),
        label: it.name,
        execute: it.execute,
      });
    }
  }

  // --- reading an image, for a chat model that cannot see one ---
  //
  // Gated only on the gateway, not on RustFS: the common source is a file in
  // the workspace, which needs no bucket. `execCwd` is passed rather than
  // recomputed because it is the directory the system prompt already names, so
  // a relative path the model writes resolves where the model was told it would.
  if (visionConfigured()) {
    for (const vt of createVisionTools(workspaceId, execCwd)) {
      agentTools.push({
        name: vt.name,
        description: vt.description,
        parameters: jsonSchemaToTypebox(vt.parameters as Record<string, unknown>),
        label: vt.name,
        execute: vt.execute,
      });
    }
  }

  // --- handing a file back to the user ---
  //
  // Ungated on purpose, and the only tool here that is. Every other media tool
  // needs a bucket or a gateway; this one degrades to a workspace download URL
  // that the API serves either way. A run that produces a file and cannot say
  // where it is has not finished, whatever else is configured.
  for (const st of createShareTools(workspaceId, execCwd, undefined, conversationId)) {
    agentTools.push({
      name: st.name,
      description: st.description,
      parameters: jsonSchemaToTypebox(st.parameters as Record<string, unknown>),
      label: st.name,
      execute: st.execute,
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

  // --- calendar: live Google Calendar tools, only when an account is connected ---
  // Gated on a connected `gcal` connector, not on the harness, for the same
  // reason MCP is: the opt-in already happened when someone authorised the
  // account. A workspace with no calendar sees none of these tools, so the list
  // stays clean. The store read is one indexed query and must not fail the run.
  let hasCalendar = false;
  try {
    const wsConnectors = await connectorStore.list(workspaceId);
    if (wsConnectors.some((con) => con.kind === "gcal")) {
      hasCalendar = true;
      for (const ct of createCalendarTools(workspaceId)) {
        agentTools.push({
          name: ct.name,
          description: ct.description,
          parameters: jsonSchemaToTypebox(ct.parameters as Record<string, unknown>),
          label: ct.label,
          execute: ct.execute,
        });
      }
    }
  } catch (e) {
    logger.warn("calendar.tools_failed", { run: runId, error: (e as Error).message });
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
  // Filled in once the harness exists; `search_tools` widens its active tool
  // set through this. See `createToolActivator`.
  const mcpActivator = createToolActivator();
  try {
    mcp = await createMcpTools(workspaceId, undefined, undefined, {
      activator: mcpActivator,
      // The agent's own working directory, so a spilled result's path is one
      // the `read` and `bash` tools resolve — under Docker the workspace is
      // mounted at an identical host and container path, and under the node
      // backend there is only one path to begin with.
      workspacePath: execCwd,
      // A connection is now opened by the first tool call that needs one, which
      // is somewhere in the middle of a run rather than at its start. Traced
      // where it happens, or the seconds it costs would go unattributed.
      onConnect: (o) =>
        emit({
          type: "trace",
          step: "mcp.connect",
          fields: {
            server: o.server,
            ms: o.ms,
            ok: o.ok,
            ...(o.error ? { error: o.error } : {}),
          },
        }),
      requestApproval: requestUserInput
        ? async (request, toolSignal) => {
            const answer = await requestUserInput(
              {
                question: request.question,
                options: [...APPROVAL_OPTIONS],
                kind: "approval",
              },
              toolSignal ?? signal,
            );
            const approved = approvalGranted(answer);
            emit({
              type: "trace",
              step: "mcp.approval",
              fields: {
                server: request.server,
                tool: request.tool,
                destructive: request.destructive,
                approved,
              },
            });
            return approved;
          }
        : undefined,
    });
    // Building the runtime no longer connects to anything — the catalog comes
    // from `mcp_capabilities`. This span is what proves that: it read ~4-6
    // seconds per run before, and should now read single-digit milliseconds
    // unless a server had no cached catalog and had to be probed.
    emit({
      type: "trace",
      step: "mcp.catalog",
      fields: {
        ms: mcpTimer.elapsed(),
        servers: mcp.servers.map((sv) => sv.name).join(", ") || "(none)",
        ok: mcp.servers.every((sv) => sv.ok),
        failed: mcp.servers.filter((sv) => !sv.ok).length,
        // The two numbers this whole mechanism exists to separate: how many
        // tools the workspace can reach, and how many are occupying context.
        advertised: mcp.tools.length,
        active: mcp.activeToolNames.length,
        probed: mcp.servers.filter((sv) => !sv.cached).length,
      },
    });
    // One span per server as well, so a failure names which one.
    for (const sv of mcp.servers) {
      emit({
        type: "trace",
        step: "mcp.server",
        fields: {
          name: sv.name,
          ms: sv.ms,
          transport: sv.transport,
          ok: sv.ok,
          cached: sv.cached,
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

  // What earlier runs in this workspace learned. Injected rather than offered
  // as a tool: `recall` has existed for as long as the agent has, and the run
  // that motivated this one never called it — a fact the model has to decide to
  // look up is a fact it does not have.
  let playbookPrompt = "";
  try {
    playbookPrompt = renderPlaybook(await playbookStore.list(workspaceId));
  } catch (e: any) {
    logger.warn("playbook.load_failed", { workspaceId, message: e?.message ?? String(e) });
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

  // The user's own Google Calendar is authoritative over any other calendar a
  // connected service happens to expose (e.g. a Nextcloud MCP server's calendar
  // tools): when both exist, an unqualified "my calendar" means the Google one.
  // Said in the prompt rather than left to the model to infer from tool names.
  const calendarPrompt = hasCalendar
    ? `\n\nThe user's calendar is Google Calendar, reached with the "calendar_*" tools ` +
      `(calendar_list_events, calendar_create_event, and so on). For ANY question about the user's ` +
      `calendar, schedule, meetings, events, or availability, you MUST use the "calendar_*" tools. ` +
      `Do NOT use any other service's calendar tools for this — in particular, do not call a ` +
      `Nextcloud "nc_calendar_*" tool for the user's calendar. Use another calendar only if the user ` +
      `explicitly names that service (e.g. "check my Nextcloud calendar").`
    : "";

  // #2: systemPrompt as a function that adapts to the active tool set/model.
  const systemPromptFn = (ctx: any): string => {
    const activeNames = (ctx?.activeTools ?? []).map((t: any) => t.name);
    const activeTools = activeNames.join(", ");
    // The active set as *pi* resolved it, not as this file computed it.
    //
    // Those two can disagree — a name that never reaches the harness produces a
    // model that insists a tool does not exist, which is indistinguishable from
    // the model simply refusing to call it. This is the span that tells the two
    // apart, and it is emitted per turn because `search_tools` widens the set
    // mid-run.
    emit({
      type: "trace",
      step: "llm.tools",
      fields: { count: activeNames.length, tools: activeTools },
    });
    let out = systemPrompt;
    if (activeTools) out += `\n\nAvailable tools: ${activeTools}.`;
    // Before the MCP block, deliberately. The agent's own machine is the
    // default place; the remote services are the exception, and the prompt
    // should introduce them in that order.
    out += describeEnvironment({
      backend: appEnv.sandboxBackend === "docker" ? "docker" : "node",
      cwd: execCwd,
      hasExternalServices: Boolean(mcp?.systemPromptBlock),
    });
    if (docsPrompt) out += docsPrompt;
    if (dbPrompt) out += dbPrompt;
    if (calendarPrompt) out += calendarPrompt;
    // Always on when the run can be answered: prefer asking to guessing.
    if (conversationId) {
      out +=
        `\n\nWhen the user's request is ambiguous, or more than one thing matches and they did not ` +
        `say which, call the "ask_user" tool to ask them rather than guessing — offer the likely ` +
        `answers as options. Always ask before an action that is hard to undo when you are unsure.`;
    }
    // After the environment and the corpora, before the MCP block: the playbook
    // is commentary on the tools described around it, so it reads as commentary
    // only once they have been introduced.
    if (playbookPrompt) out += playbookPrompt;
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

  // Registered and active are deliberately different sets.
  //
  // pi builds the provider request from `activeToolNames` alone (see
  // `AgentHarness.createTurnState`), so a registered-but-inactive tool costs
  // nothing until something activates it. That is what makes 151 MCP tools
  // affordable: every local tool stays on, and the MCP catalog contributes only
  // the handful this workspace actually uses, plus `search_tools` to reach the
  // rest. The floor this removes was measured at 36,512 tokens per turn.
  const allTools = [...builtinTools, ...agentTools];
  const mcpCatalog = new Set<string>((mcp?.tools ?? []).map((t: any) => t.name));
  const mcpActive = new Set<string>(mcp?.activeToolNames ?? []);
  const activeToolNames = allTools
    .map((tool) => tool.name)
    .filter((name) => !mcpCatalog.has(name) || mcpActive.has(name));

  const session = new Session(new InMemorySessionStorage());
  const harness = new AgentHarness({
    session,
    models,
    model: m,
    thinkingLevel: reasoning ? "high" : ("off" as any),
    systemPrompt: systemPromptFn,
    resources: { skills, promptTemplates },
    toolContext: { env: execEnv },
    tools: allTools,
    activeToolNames,
  });

  // The harness exists now, so `search_tools` has something to widen. Bound
  // before any turn can run, which is what makes the unbound state unreachable.
  mcpActivator.bind(harness);

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

  // A thinking model's request body is patched here, on the raw payload, because
  // pi-ai's completions adapter cannot produce the shape this gateway needs:
  // Qwen thinking turns on through `chat_template_kwargs.enable_thinking` (a bare
  // top-level `enable_thinking` is ignored — measured), and the effort rides
  // alongside as a top-level `reasoning_effort`, but the adapter emits one or
  // the other, never both. So the whole thinking recipe is merged in here,
  // wholesale, from the model's own `thinking` config plus the run's chosen
  // effort — this is also the only path that carries the sampling params
  // (top_p/top_k/penalties) the adapter otherwise drops.
  if (model.thinking) {
    const effort = model.thinking.levels.includes(reasoningEffort ?? "")
      ? (reasoningEffort as string)
      : model.thinking.default;
    harness.on("before_provider_payload", ({ payload }) => ({
      payload: {
        ...(payload as Record<string, unknown>),
        ...model.thinking!.sampling,
        reasoning_effort: effort,
        chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      },
    }));
  }

  if (signal) {
    // Already aborted is possible: a stop can land in the gap between the
    // controller being created and the harness existing. `addEventListener`
    // would never fire for it, so the run would finish uncancelled — check the
    // flag directly as well.
    if (signal.aborted) void harness.abort().catch(() => {});
    else signal.addEventListener("abort", () => harness.abort().catch(() => {}), { once: true });
  }

  let turns = 0;
  // Assistant text actually streamed to the user, and the biggest single tool
  // result of the run. Both exist for the completion check below: a run that
  // ends with zero answer needs to say why, and the largest tool result is
  // almost always the reason.
  let answerChars = 0;
  /** The answer itself, capped. See ANSWER_KEEP_CHARS. */
  let answerText = "";
  let largestToolResult = { name: "", chars: 0 };
  /** Provider-reported prompt size of the most recent turn. 0 until one lands. */
  let realTokens = 0;
  /** When the turn in flight began, so `llm.turn` can be measured. */
  let turnStartedAt = 0;
  /** Tool calls and failures across the run, for the run summary. */
  let toolCalls = 0;
  let toolErrors = 0;
  /**
   * Every call, for the reflector.
   *
   * Kept in memory rather than read back from `traces` afterwards: the spans
   * are flushed in batches, so a query issued the moment the run ends is racing
   * its own writes. This array is the same data, already in hand.
   */
  const toolLog: ToolCallRecord[] = [];

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
            // Bounded copy of the answer, for the reflector. Capped because a
            // run that emits a 200KB answer should not then send 200KB to a
            // second model to be reflected on.
            if (answerText.length < ANSWER_KEEP_CHARS) answerText += a.delta;
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
          toolLog.push({
            name: event.toolName,
            ok: !failed,
            args,
            resultChars: text.length,
          });

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
            // Carried for the same reason the start time and arguments are held
            // per call id above: tools run in parallel and finish out of order,
            // so the name alone does not say which call this answers.
            id: event.toolCallId,
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

  // The active set, not everything registered: this is what the model can see,
  // and the panel claiming 151 tools while the model was shown 20 would be a
  // lie in the direction that matters.
  emit({ type: "slots", mode: "tools", tools: activeToolNames });

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

    // Reflection, after the answer and outside its critical path.
    //
    // Deliberately not awaited: it is a second model call, and the user is
    // already reading their reply. Awaiting it would hold the response stream
    // open for the length of a whole extra round trip in exchange for nothing
    // the user sees. Its failures are logged inside `reflect` and swallowed
    // here — a run that answered correctly must not be reported as failed
    // because the thing that learns from it did not.
    void reflect({
      workspaceId,
      runId: runId === "-" ? null : runId,
      model,
      history,
      answer: answerText,
      toolCalls: toolLog,
    }).catch((e) => {
      logger.warn("playbook.reflect_crashed", { run: runId, message: (e as Error)?.message });
    });
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

/**
 * How much of the answer is kept for the reflector.
 *
 * Larger than the span preview, because a fact worth learning ("your Plane
 * workspace is at …") often arrives well into a long answer, and smaller than
 * unbounded, because this text is about to be sent to a second model.
 */
const ANSWER_KEEP_CHARS = 8_000;

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
