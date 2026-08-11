import type { Context } from "hono";
import { conversationRepository } from "../repositories/conversation.repository";
import { env } from "../config/env";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { currentUserId } from "../middleware/auth";

/**
 * The workspace this request applies to. `resolve` is the one place a
 * client-supplied workspace id is checked against ownership.
 */
const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/** GET /api/conversations — a workspace's conversations, newest first. */
export async function index(c: Context) {
  const conversations = await conversationRepository.list(await workspaceIdOf(c));
  return c.json({ conversations });
}

/** GET /api/conversations/:id — one conversation with its transcript and trace. */
export async function show(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing conversation id" }, 400);

  const conversation = await conversationRepository.get(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const [messages, traces] = await Promise.all([
    conversationRepository.listMessages(id),
    conversationRepository.listTraces(id),
  ]);
  return c.json({ conversation, messages, traces });
}

/** DELETE /api/conversations/:id — removes its messages and traces too. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing conversation id" }, 400);

  const conversation = await conversationRepository.get(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  await conversationRepository.remove(id);
  return c.body(null, 204);
}
