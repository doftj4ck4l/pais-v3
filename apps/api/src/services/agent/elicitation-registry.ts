/**
 * In-process map of an outstanding `ask_user` question to its resolver.
 *
 * When the agent calls the `ask_user` tool, the tool blocks the run by awaiting
 * a promise whose `resolve` is parked here under a questionId. The answer
 * arrives on a second HTTP request (POST /api/chat/:conversationId/answer),
 * which looks the resolver up and fires it — the same "pause the in-process run
 * until another request resolves it" shape as `run-registry.ts`.
 *
 * The conversationId is stored alongside so the answer endpoint can confirm the
 * question belongs to the conversation the caller owns before resolving it — a
 * questionId is unguessable, but a stray answer must never land on another
 * tenant's run.
 */

type Resolver = (answer: string) => void;

const pending = new Map<string, { conversationId: string; resolve: Resolver }>();

export function registerQuestion(
  questionId: string,
  conversationId: string,
  resolve: Resolver,
): void {
  pending.set(questionId, { conversationId, resolve });
}

/**
 * Deliver an answer to the waiting run. Returns false if there is no question
 * by that id, or it belongs to a different conversation than the caller's —
 * either way nothing is resolved.
 */
export function answerQuestion(
  conversationId: string,
  questionId: string,
  answer: string,
): boolean {
  const entry = pending.get(questionId);
  if (!entry || entry.conversationId !== conversationId) return false;
  pending.delete(questionId);
  entry.resolve(answer);
  return true;
}

/** Drop a question without answering it — the tool calls this when its run aborts. */
export function cancelQuestion(questionId: string): void {
  pending.delete(questionId);
}

/** Whether a question is still waiting. Test/observability helper. */
export function hasQuestion(questionId: string): boolean {
  return pending.has(questionId);
}
