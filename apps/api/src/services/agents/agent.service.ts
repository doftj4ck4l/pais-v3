import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getModel } from "../../catalog/llm-models";
import { env } from "../../config/env";
import {
  agentStore,
  type AgentDefinitionRow,
  type AgentStore,
  type UpdateAgentDefinition,
} from "../../repositories/agent.repository";
import type { AssistantChunk } from "../../types/chat";
import { chatOnce, type ProviderMessage } from "../agent/provider.service";

const NAME_MAX = 80;
const PROMPT_MAX = 12_000;
const MESSAGE_MAX = 20_000;
const HISTORY_MAX = 20;
const HISTORY_CHARS_MAX = 60_000;

export type AgentView = Omit<AgentDefinitionRow, "tokenDigest">;
export type AgentInput = { name: string; systemPrompt: string; modelId: string };
export type AgentMessage = { role: "user" | "assistant"; content: string };
export type AgentReply = {
  agentId: string;
  agentName: string;
  modelId: string;
  reply: string;
};

type Chat = (
  model: NonNullable<ReturnType<typeof getModel>>,
  messages: ProviderMessage[],
  tools: [],
  signal?: AbortSignal,
) => Promise<AssistantChunk>;

export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}

export class InvalidAgentTokenError extends Error {
  constructor() {
    super("Agent not found or API key is invalid");
    this.name = "InvalidAgentTokenError";
  }
}

export class AgentNotFoundError extends Error {
  constructor() {
    super("Agent not found");
    this.name = "AgentNotFoundError";
  }
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const mintToken = () => `psa_${randomBytes(32).toString("base64url")}`;
const publicAgent = ({ tokenDigest: _tokenDigest, ...agent }: AgentDefinitionRow): AgentView => agent;

function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function definition(input: unknown): AgentInput {
  const value = record(input);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if (!name) throw new AgentInputError("Name is required");
  if (name.length > NAME_MAX) throw new AgentInputError(`Name must be ${NAME_MAX} characters or fewer`);
  if (!systemPrompt) throw new AgentInputError("System prompt is required");
  if (systemPrompt.length > PROMPT_MAX) {
    throw new AgentInputError(`System prompt must be ${PROMPT_MAX.toLocaleString()} characters or fewer`);
  }
  if (!getModel(modelId)) throw new AgentInputError(`Unknown model "${modelId}"`);
  return { name, systemPrompt, modelId };
}

function invocation(input: unknown): { message: string; history: AgentMessage[] } {
  const value = record(input);
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!message) throw new AgentInputError("Message is required");
  if (message.length > MESSAGE_MAX) {
    throw new AgentInputError(`Message must be ${MESSAGE_MAX.toLocaleString()} characters or fewer`);
  }
  const history = value.history ?? [];
  if (!Array.isArray(history) || history.length > HISTORY_MAX) {
    throw new AgentInputError(`History may contain at most ${HISTORY_MAX} messages`);
  }
  let chars = 0;
  const clean: AgentMessage[] = history.map((item): AgentMessage => {
    const value = record(item);
    const role = value.role;
    if (role !== "user" && role !== "assistant") {
      throw new AgentInputError("History roles must be user or assistant");
    }
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (!content) throw new AgentInputError("History messages cannot be empty");
    chars += content.length;
    return { role, content };
  });
  if (chars > HISTORY_CHARS_MAX) {
    throw new AgentInputError(`History must be ${HISTORY_CHARS_MAX.toLocaleString()} characters or fewer`);
  }
  return { message, history: clean };
}

export class AgentService {
  constructor(
    private readonly store: AgentStore = agentStore,
    private readonly chat: Chat = chatOnce,
    private readonly invocationTimeoutMs = env.agentInvocationTimeoutMs,
  ) {}

  async list(workspaceId: string): Promise<AgentView[]> {
    return (await this.store.list(workspaceId)).map(publicAgent);
  }

  async create(workspaceId: string, input: unknown): Promise<{ agent: AgentView; token: string }> {
    const clean = definition(input);
    const token = mintToken();
    const row = await this.store.create({
      id: randomUUID(),
      workspaceId,
      ...clean,
      tokenDigest: digest(token),
      tokenHint: token.slice(-4),
    });
    return { agent: publicAgent(row), token };
  }

  async update(workspaceId: string, id: string, input: unknown): Promise<AgentView | null> {
    const row = await this.store.update(workspaceId, id, definition(input));
    return row ? publicAgent(row) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return this.store.remove(workspaceId, id);
  }

  async rotateToken(
    workspaceId: string,
    id: string,
  ): Promise<{ agent: AgentView; token: string } | null> {
    const token = mintToken();
    const row = await this.store.update(workspaceId, id, {
      tokenDigest: digest(token),
      tokenHint: token.slice(-4),
    });
    return row ? { agent: publicAgent(row), token } : null;
  }

  async invoke(token: string, input: unknown): Promise<AgentReply> {
    return this.invokeAuthorized(await this.authenticate(token), input);
  }

  async authenticate(token: string): Promise<AgentDefinitionRow> {
    if (!token.startsWith("psa_")) throw new InvalidAgentTokenError();
    const agent = await this.store.findByTokenDigest(digest(token));
    if (!agent) throw new InvalidAgentTokenError();
    return agent;
  }

  async invokeAuthorized(agent: AgentDefinitionRow, input: unknown): Promise<AgentReply> {
    return this.run(agent, input, AbortSignal.timeout(this.invocationTimeoutMs));
  }

  async preview(workspaceId: string, id: string, input: unknown): Promise<AgentReply> {
    const agent = await this.store.getOwned(workspaceId, id);
    if (!agent) throw new AgentNotFoundError();
    return this.run(agent, input);
  }

  private async run(
    agent: AgentDefinitionRow,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    const clean = invocation(input);
    const model = getModel(agent.modelId);
    if (!model) throw new AgentInputError(`Unknown model "${agent.modelId}"`);
    const result = await this.chat(
      model,
      [
        { role: "system", content: agent.systemPrompt },
        ...clean.history,
        { role: "user", content: clean.message },
      ],
      [],
      signal,
    );
    const reply = result.text.trim() || result.reasoningContent.trim();
    if (!reply) throw new Error("The model finished without producing an answer");
    // Usage recency is presentation metadata. A transient database write
    // failure after the provider answered must not discard a valid reply.
    void this.store.markUsed(agent.id).catch(() => undefined);
    return { agentId: agent.id, agentName: agent.name, modelId: agent.modelId, reply };
  }
}

export const agentService = new AgentService();
