import type { ChatMessage } from "../types/chat";

/**
 * Context budgeting for a threaded conversation.
 *
 * A thread grows every turn, so something has to decide when the history no
 * longer fits and what to drop. That decision lives here, away from both the
 * HTTP layer and the agent loop, and is pure enough to test with plain messages.
 */

/** Reserved for the model's own reply plus system prompt and tool schemas. */
export const RESERVE_TOKENS = 8_000;

/** Compact once the thread passes this share of the usable window. */
export const COMPACT_AT = 0.8;

/** Recent turns to keep verbatim after compaction, as a share of the window. */
export const KEEP_RECENT = 0.35;

/**
 * Token estimate for a message.
 *
 * A character heuristic, not a tokenizer: the gateway serves several models and
 * exposes no tokenizer endpoint, so an exact count is not obtainable client-side.
 * Four characters per token is the usual English approximation and errs high for
 * code, which is the safe direction for a budget. Real provider counts replace
 * this the moment a turn completes — see `usageTokens`.
 */
export function estimateTokens(message: ChatMessage): number {
  const text = message.content ?? "";
  const toolCalls = message.tool_calls
    ? JSON.stringify(message.tool_calls).length
    : 0;
  // +4 covers the per-message role/delimiter overhead every chat format adds.
  return Math.ceil((text.length + toolCalls) / 4) + 4;
}

export function estimateHistoryTokens(history: ChatMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/** What a model can actually be given, once room for its reply is reserved. */
export function usableWindow(contextWindow: number): number {
  return Math.max(1, contextWindow - RESERVE_TOKENS);
}

export type CompactionPlan = {
  /** Messages to summarise away. */
  summarise: ChatMessage[];
  /** Messages kept verbatim, newest turns first in document order. */
  keep: ChatMessage[];
  tokensBefore: number;
};

/**
 * Decide what to summarise, or return null when the thread still fits.
 *
 * The cut is taken at a user message so a summary never splits a turn from its
 * tool calls and reply — a fragment of a turn summarises badly and reads worse.
 * The very last user message is always kept: it is the question being asked.
 */
export function planCompaction(
  history: ChatMessage[],
  contextWindow: number,
): CompactionPlan | null {
  const usable = usableWindow(contextWindow);
  const tokensBefore = estimateHistoryTokens(history);
  if (tokensBefore <= usable * COMPACT_AT) return null;

  const keepBudget = Math.floor(usable * KEEP_RECENT);
  let kept = 0;
  let cut = history.length;

  // Walk backwards accumulating recent messages until the keep-budget is spent,
  // then snap the cut forward to the nearest user message.
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i]!);
    if (kept + cost > keepBudget && i < history.length - 1) break;
    kept += cost;
    cut = i;
  }
  while (cut > 0 && history[cut]?.role !== "user") cut--;

  // Nothing old enough to be worth summarising: the tail alone is oversized.
  // Compacting here would summarise the current question, so leave it be and
  // let the caller report the overflow instead.
  if (cut <= 0) return null;

  return { summarise: history.slice(0, cut), keep: history.slice(cut), tokensBefore };
}

/** The history to actually send: a summary turn followed by the recent tail. */
export function applyCompaction(plan: CompactionPlan, summary: string): ChatMessage[] {
  return [
    {
      role: "user",
      content:
        `[Summary of the earlier conversation, condensed to fit the context window]\n\n${summary}`,
    },
    { role: "assistant", content: "Understood — I have the earlier context." },
    ...plan.keep,
  ];
}
