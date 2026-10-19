import {
  createCompactionSummaryMessage,
  estimateContextTokens,
  estimateTokens,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { COMPACT_AT, KEEP_TOOL_RESULTS, usableWindow } from "./context-window.service";

/**
 * Mid-run compaction.
 *
 * `fitToWindow` runs once, before a run starts, and nothing intervenes while
 * the run executes. A single agentic run can execute 44+ turns of large tool
 * output and grow from 23k to 128k tokens inside itself; the final turns are
 * left without room and come back empty, which is what a user sees as a chat
 * that "dies" until the next message compacts it one run too late.
 *
 * pi's harness exposes one sanctioned lever for this: the `context` hook,
 * awaited before every provider request, may rewrite the message list sent to
 * the model. It receives the session's own messages — the session is
 * append-only and is never mutated from here, so the stored transcript keeps
 * everything — and the reduced list is rebuilt on every turn that needs it.
 *
 * The policy mirrors `planCompaction` so there is one definition of "full"
 * across the codebase: prune stale tool results first, then summarise the
 * older turns at a user-message boundary, never cutting away the last user
 * message.
 */

/** What one pruned tool result becomes. Same wording as the pre-run pruner. */
const PRUNED_PLACEHOLDER = "[earlier tool output removed to fit the context window]";

export type MidRunPruneOutcome = {
  messages: AgentMessage[];
  pruned: number;
  savedTokens: number;
};

/**
 * Replace the content of all but the most recent tool results.
 *
 * The messages stay in place rather than being deleted — a tool result whose
 * tool call disappears is rejected outright by providers — and are *copied*
 * rather than mutated, because the input array shares objects with pi's
 * session. Positions are preserved, so an index into the input array indexes
 * the output array identically.
 */
export function pruneAgentToolResults(
  messages: AgentMessage[],
  keepRecent = KEEP_TOOL_RESULTS,
): MidRunPruneOutcome {
  const toolIndexes = messages
    .map((m, i) => (m.role === "toolResult" ? i : -1))
    .filter((i) => i >= 0);

  const prunable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));
  if (!prunable.length) return { messages, pruned: 0, savedTokens: 0 };

  const drop = new Set(prunable);
  let savedTokens = 0;
  const next = messages.map((m, i) => {
    if (!drop.has(i) || m.role !== "toolResult") return m;
    const before = estimateTokens(m);
    const pruned = {
      ...m,
      content: [{ type: "text" as const, text: PRUNED_PLACEHOLDER }],
    };
    savedTokens += before - estimateTokens(pruned);
    return pruned as AgentMessage;
  });

  return { messages: next, pruned: prunable.length, savedTokens };
}

/**
 * What replaces the summarised head of the session for this run's requests.
 *
 * Either a single compaction summary message, or nothing at all when the
 * reduction came from pruning alone. `cutRef` is the message object that was
 * at `cutIndex` when the form was chosen; the session only appends, so the
 * identity of that object proves the cut still lands in the same place.
 */
export type MidRunCache = {
  cutIndex: number;
  cutRef: AgentMessage | undefined;
  prefix: AgentMessage[];
};

export type MidRunPlan =
  | { action: "none" }
  /** A ready-to-send replacement list; no model call needed. */
  | {
      action: "apply";
      history: AgentMessage[];
      fromTokens: number;
      toTokens: number;
      pruned: number;
      /** Set when this form was chosen fresh; the caller stores it. */
      cache?: MidRunCache;
    }
  /** Older turns to summarise away; the caller generates the summary text. */
  | {
      action: "summarise";
      summarise: AgentMessage[];
      keep: AgentMessage[];
      tokensBefore: number;
      cutIndex: number;
    };

/**
 * Plain char-heuristic sum.
 *
 * `estimateContextTokens` trusts the usage block of the last assistant
 * message, which on a synthetic list is a figure from a different — full-size
 * — request and would wildly overstate. Use it only on lists the harness
 * itself would send.
 */
export function estimateListTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/** Cut selection shared by every fresh decision. */
function summarisePlan(
  messages: AgentMessage[],
  pruned: AgentMessage[],
  fromTokens: number,
  usable: number,
): Extract<MidRunPlan, { action: "summarise" }> | { action: "none" } {
  // Walk backwards accumulating recent messages until the keep budget is
  // spent, then snap the cut forward to the nearest user message — a summary
  // never splits a turn from its tool calls and reply. The cut is an index
  // into the ORIGINAL list; pruning preserves positions, so it indexes the
  // pruned array identically.
  const keepBudget = Math.floor(usable * 0.35);
  let kept = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i]!);
    if (kept + cost > keepBudget && i < messages.length - 1) break;
    kept += cost;
    cut = i;
  }
  while (cut > 0 && messages[cut]?.role !== "user") cut--;

  // Nothing old enough to be worth summarising: the tail alone is oversized.
  // Compacting here would summarise the current question, so leave it be.
  if (cut <= 0) return { action: "none" };

  return {
    action: "summarise",
    // The summariser reads the pruned head — same content, smaller request.
    summarise: pruned.slice(0, cut),
    keep: messages.slice(cut),
    tokensBefore: fromTokens,
    cutIndex: cut,
  };
}

/**
 * Decide what to send for this request, or return "none" when it still fits.
 *
 * Occupancy comes from `estimateContextTokens`, which uses the provider's own
 * usage figure from the most recent assistant message when one exists and
 * estimates only the messages added since — the same honesty as the meter,
 * without a second accounting.
 *
 * The cache is checked *before* the threshold: once a reduced form exists, the
 * provider-reported usage it reads belongs to the reduced request and would
 * read small, so dropping the check here would send the full session list
 * again and walk straight back into the window.
 */
export function planMidRunCompaction(
  messages: AgentMessage[],
  contextWindow: number,
  cached?: MidRunCache,
): MidRunPlan {
  if (!messages.length) return { action: "none" };
  const usable = usableWindow(contextWindow);
  const fromTokens = estimateContextTokens(messages).tokens;

  if (cached && messages[cached.cutIndex] === cached.cutRef) {
    const tail = pruneAgentToolResults(messages.slice(cached.cutIndex));
    const history = [...cached.prefix, ...tail.messages];
    const toTokens = estimateContextTokens(history).tokens;
    if (toTokens <= usable * COMPACT_AT) {
      return { action: "apply", history, fromTokens, toTokens, pruned: tail.pruned };
    }
    // The kept tail has itself grown past budget. A deeper cut is the fix;
    // its summary subsumes whatever the previous form preserved. If no cut is
    // possible, the reduced form is still the smallest thing available — send
    // it rather than the full session list.
    const deeper = summarisePlan(messages, pruneAgentToolResults(messages).messages, fromTokens, usable);
    if (deeper.action !== "none") return deeper;
    return { action: "apply", history, fromTokens, toTokens, pruned: tail.pruned };
  }

  if (fromTokens <= usable * COMPACT_AT) return { action: "none" };

  // Prune before summarising. Dropping stale tool output is free and nearly
  // lossless; summarising costs a model call inside the run's critical path.
  const prune = pruneAgentToolResults(messages);
  if (prune.pruned && fromTokens - prune.savedTokens <= usable * COMPACT_AT) {
    return {
      action: "apply",
      history: prune.messages,
      fromTokens,
      toTokens: fromTokens - prune.savedTokens,
      pruned: prune.pruned,
      // The reduction is a pure function of the session list, so the form to
      // remember is "no prefix, keep everything from the start".
      cache: { cutIndex: 0, cutRef: messages[0], prefix: [] },
    };
  }

  return summarisePlan(messages, prune.messages, fromTokens, usable);
}

/** The request list once a fresh summary text exists. */
export function applyMidRunCompaction(
  plan: Extract<MidRunPlan, { action: "summarise" }>,
  summary: string,
): AgentMessage[] {
  return [
    createCompactionSummaryMessage(summary, plan.tokensBefore, new Date().toISOString()),
    ...plan.keep,
  ];
}
