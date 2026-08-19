import type { Context } from "hono";
import { currentUserId } from "../middleware/auth";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import {
  AgentInputError,
  AgentNotFoundError,
  agentService,
  InvalidAgentTokenError,
} from "../services/agents/agent.service";

const ENDPOINT = "/api/agents/invoke";
const INVOCATION_BODY_MAX_BYTES = 96 * 1024;

class InvocationBodyTooLargeError extends Error {}

async function workspaceIdOf(c: Context): Promise<string> {
  const workspace = await workspaceRegistry.resolve(currentUserId(c), c.req.query("workspaceId"));
  return workspace.id;
}

async function bodyOf(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

async function invocationBodyOf(c: Context): Promise<unknown> {
  const declaredSize = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > INVOCATION_BODY_MAX_BYTES) {
    throw new InvocationBodyTooLargeError();
  }

  const reader = c.req.raw.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > INVOCATION_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new InvocationBodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

function failure(c: Context, error: unknown) {
  if (error instanceof AgentInputError) return c.json({ error: error.message }, 400);
  if (error instanceof AgentNotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof InvalidAgentTokenError) return c.json({ error: error.message }, 401);
  if (error instanceof InvocationBodyTooLargeError) {
    return c.json({ error: "Request body is too large" }, 413);
  }
  return c.json({ error: "The agent could not answer right now" }, 502);
}

function withEndpoint<T extends object>(value: T) {
  return { ...value, endpoint: ENDPOINT };
}

/** GET /api/agents — prompt agents in the selected workspace. */
export async function index(c: Context) {
  const agents = await agentService.list(await workspaceIdOf(c));
  return c.json({ agents: agents.map(withEndpoint) });
}

/** POST /api/agents — create and reveal the initial bearer key once. */
export async function create(c: Context) {
  try {
    const result = await agentService.create(await workspaceIdOf(c), await bodyOf(c));
    return c.json({ ...result, agent: withEndpoint(result.agent) }, 201);
  } catch (error) {
    return failure(c, error);
  }
}

/** PATCH /api/agents/:id — update the model-facing definition. */
export async function update(c: Context) {
  try {
    const agent = await agentService.update(
      await workspaceIdOf(c),
      c.req.param("id") ?? "",
      await bodyOf(c),
    );
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({ agent: withEndpoint(agent) });
  } catch (error) {
    return failure(c, error);
  }
}

/** POST /api/agents/:id/token — invalidate the old key and reveal a new one once. */
export async function rotateToken(c: Context) {
  try {
    const result = await agentService.rotateToken(await workspaceIdOf(c), c.req.param("id") ?? "");
    if (!result) return c.json({ error: "Agent not found" }, 404);
    return c.json({ ...result, agent: withEndpoint(result.agent) });
  } catch (error) {
    return failure(c, error);
  }
}

/** POST /api/agents/:id/preview — try an owned agent without handling its secret. */
export async function preview(c: Context) {
  try {
    const reply = await agentService.preview(
      await workspaceIdOf(c),
      c.req.param("id") ?? "",
      await bodyOf(c),
    );
    return c.json(reply);
  } catch (error) {
    return failure(c, error);
  }
}

/** DELETE /api/agents/:id */
export async function destroy(c: Context) {
  const removed = await agentService.remove(await workspaceIdOf(c), c.req.param("id") ?? "");
  if (!removed) return c.json({ error: "Agent not found" }, 404);
  return c.body(null, 204);
}

/** POST /api/agents/invoke — bearer-key surface for bots and other services. */
export async function invoke(c: Context) {
  const match = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return c.json({ error: "A Bearer agent API key is required" }, 401);
  try {
    const agent = await agentService.authenticate(match[1].trim());
    return c.json(await agentService.invokeAuthorized(agent, await invocationBodyOf(c)));
  } catch (error) {
    return failure(c, error);
  }
}
