import { describe, expect, it } from "bun:test";
import {
  createCompactionSummaryMessage,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  applyMidRunCompaction,
  estimateListTokens,
  planMidRunCompaction,
  pruneAgentToolResults,
  type MidRunCache,
} from "./midrun-compaction";

// The catalog default window, so the thresholds here are the ones production
// runs against: usable 123,072, compact above 80% of that.
const WINDOW = 131_072;

let seq = 0;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: ++seq });
const assistant = (text: string, usage?: { input: number; cacheRead: number }): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text" as const, text }],
  api: "openai-completions",
  provider: "gw",
  model: "test",
  stopReason: "stop",
  // Zero usage is not counted by pi's estimator, so this reads as "no
  // provider figure yet" rather than a tiny context.
  usage: usage
    ? { input: usage.input, output: 10, cacheRead: usage.cacheRead, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: ++seq,
});
const toolResult = (name: string, text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: `call_${++seq}`,
  toolName: name,
  content: [{ type: "text" as const, text }],
  isError: false,
  timestamp: ++seq,
});
/** A tool result of roughly `tokens` estimated tokens. */
const bulkyToolResult = (name: string, tokens: number): AgentMessage =>
  toolResult(name, "z".repeat(tokens * 4));
const textOf = (m: AgentMessage): string =>
  m.role === "toolResult" || m.role === "user" || m.role === "custom"
    ? String((m as any).content?.[0]?.text ?? "")
    : "";

const PRUNED_MARK = "removed to fit";

describe("pruneAgentToolResults", () => {
  it("copies rather than mutates shared message objects", () => {
    const original = toolResult("t", "x".repeat(4000));
    const out = pruneAgentToolResults([original], 0);
    expect(out.pruned).toBe(1);
    expect(textOf(original)).toHaveLength(4000);
    expect(out.messages[0]).not.toBe(original);
  });

  it("keeps the most recent tool results whole", () => {
    const old = bulkyToolResult("old", 1000);
    const fresh = bulkyToolResult("fresh", 1000);
    const out = pruneAgentToolResults([old, fresh], 1);
    expect(out.pruned).toBe(1);
    expect(out.messages[0]).not.toBe(old);
    expect(out.messages[1]).toBe(fresh);
  });

  it("preserves positions so an index into the input indexes the output", () => {
    const messages = [user("q"), bulkyToolResult("t1", 500), user("q2"), bulkyToolResult("t2", 500)];
    const out = pruneAgentToolResults(messages, 0);
    expect(out.messages).toHaveLength(messages.length);
    expect(out.messages[0]!.role).toBe("user");
    expect(out.messages[2]!.role).toBe("user");
  });
});

describe("planMidRunCompaction", () => {
  it("returns none while the thread fits", () => {
    const messages = [user("q"), assistant("a")];
    expect(planMidRunCompaction(messages, WINDOW)).toEqual({ action: "none" });
  });

  it("never mutates the input list's messages", () => {
    const messages: AgentMessage[] = [user("q")];
    const originals: AgentMessage[] = [];
    for (let i = 0; i < 13; i++) {
      const t = bulkyToolResult(`t${i}`, 8_000);
      originals.push(t);
      messages.push(t, assistant(`step ${i}`));
    }
    messages.push(user("current question"));

    const plan = planMidRunCompaction(messages, WINDOW);
    expect(plan.action).toBe("apply");
    for (const t of originals) {
      expect(textOf(t)).toHaveLength(32_000);
    }
  });

  it("prunes when stale tool output alone explains the overflow", () => {
    const messages: AgentMessage[] = [user("q")];
    for (let i = 0; i < 13; i++) {
      messages.push(bulkyToolResult(`t${i}`, 8_000), assistant(`step ${i}`));
    }
    messages.push(user("current question"));

    const plan = planMidRunCompaction(messages, WINDOW);
    expect(plan.action).toBe("apply");
    if (plan.action !== "apply") return;
    // The sent list is pruned but still carries the whole conversation.
    expect(plan.history).toHaveLength(messages.length);
    const pruned = plan.history.filter(
      (m) => m.role === "toolResult" && textOf(m).includes(PRUNED_MARK),
    );
    expect(pruned.length).toBe(7);
    // The form is remembered so the next turn reuses it without a model call.
    expect(plan.cache?.cutIndex).toBe(0);
    expect(plan.cache?.cutRef).toBe(messages[0]);
    expect(plan.cache?.prefix).toEqual([]);
  });

  it("reuses the cached form even though the raw estimate now reads small", () => {
    // The regression: after a reduced request, the provider-reported usage
    // belongs to the reduced prompt. Planning on it alone would say "fits"
    // and send the full list again, straight back into the window.
    const messages: AgentMessage[] = [user("q")];
    for (let i = 0; i < 13; i++) {
      messages.push(bulkyToolResult(`t${i}`, 8_000), assistant(`step ${i}`));
    }
    messages.push(user("current question"));

    const first = planMidRunCompaction(messages, WINDOW);
    if (first.action !== "apply" || !first.cache) throw new Error("expected apply");
    const cached = first.cache;

    const grown = [
      ...messages,
      assistant("step 13", { input: 5_000, cacheRead: 0 }),
      bulkyToolResult("t13", 4_000),
    ];
    const second = planMidRunCompaction(grown, WINDOW, cached);
    expect(second.action).toBe("apply");
    if (second.action !== "apply") return;
    expect(second.history).toHaveLength(grown.length);
    // Everything older than the kept six is still pruned in the sent list.
    const pruned = second.history.filter(
      (m) => m.role === "toolResult" && textOf(m).includes(PRUNED_MARK),
    );
    expect(pruned.length).toBe(8);
  });

  it("summarises at a user boundary when conversation text is the bulk", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`Q${i} ` + "x".repeat(30_000)), assistant(`A${i} ` + "y".repeat(30_000)));
    }
    const lastUser = messages[messages.length - 2]!;

    const plan = planMidRunCompaction(messages, WINDOW);
    expect(plan.action).toBe("summarise");
    if (plan.action !== "summarise") return;
    expect(plan.keep[0]!.role).toBe("user");
    // The question being asked is never summarised away.
    expect(plan.keep).toContain(lastUser);
    expect(plan.summarise.length).toBeGreaterThan(0);
    expect(plan.cutIndex).toBe(messages.length - plan.keep.length);
  });

  it("reuses a cached summary without a model call and keeps it first", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`Q${i} ` + "x".repeat(30_000)), assistant(`A${i} ` + "y".repeat(30_000)));
    }
    // A cut late enough that the kept tail still fits the budget.
    const cutIndex = 34;
    const cached: MidRunCache = {
      cutIndex,
      cutRef: messages[cutIndex],
      prefix: [createCompactionSummaryMessage("earlier turns", 150_000, new Date().toISOString())],
    };

    const plan = planMidRunCompaction(messages, WINDOW, cached);
    expect(plan.action).toBe("apply");
    if (plan.action !== "apply") return;
    expect(plan.history[0]!.role).toBe("compactionSummary");
    expect(plan.history).toHaveLength(1 + (messages.length - cutIndex));
    expect(plan.history[1]).toBe(messages[cutIndex]);
  });

  it("cuts deeper when the kept tail itself grows past budget", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`Q${i} ` + "x".repeat(30_000)), assistant(`A${i} ` + "y".repeat(30_000)));
    }
    const cutIndex = 26;
    const cached: MidRunCache = {
      cutIndex,
      cutRef: messages[cutIndex],
      prefix: [createCompactionSummaryMessage("earlier turns", 150_000, new Date().toISOString())],
    };

    // Five more oversized turns after the cached cut.
    for (let i = 20; i < 25; i++) {
      messages.push(user(`Q${i} ` + "x".repeat(30_000)), assistant(`A${i} ` + "y".repeat(30_000)));
    }

    const plan = planMidRunCompaction(messages, WINDOW, cached);
    expect(plan.action).toBe("summarise");
    if (plan.action !== "summarise") return;
    expect(plan.cutIndex).toBeGreaterThan(cutIndex);
  });

  it("leaves an oversized final turn alone rather than summarising the question", () => {
    const messages = [user("q " + "x".repeat(400_000))];
    expect(planMidRunCompaction(messages, WINDOW)).toEqual({ action: "none" });
  });

  it("returns none when the occupancy is weight the hook cannot touch", () => {
    // Provider usage dominated by tool schemas and the system prompt: no
    // payload change can shrink it, so there is nothing worth doing.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) messages.push(user(`Q${i}`), assistant(`A${i}`));
    messages.push(assistant("last", { input: 20_000, cacheRead: 100_000 }));
    expect(planMidRunCompaction(messages, WINDOW)).toEqual({ action: "none" });
  });
});

describe("applyMidRunCompaction", () => {
  it("builds the request list with the summary first", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`Q${i} ` + "x".repeat(30_000)), assistant(`A${i} ` + "y".repeat(30_000)));
    }
    const plan = planMidRunCompaction(messages, WINDOW);
    if (plan.action !== "summarise") throw new Error("expected summarise");
    const history = applyMidRunCompaction(plan, "the summary");
    expect(history[0]!.role).toBe("compactionSummary");
    expect((history[0] as any).summary).toBe("the summary");
    expect(history.slice(1)).toEqual(messages.slice(plan.cutIndex));
  });
});

describe("estimateListTokens", () => {
  it("sums per-message estimates without trusting usage blocks", () => {
    const messages = [user("xxxx"), assistant("yyyy")];
    expect(estimateListTokens(messages)).toBe(2);
    const summary = createCompactionSummaryMessage("abcdefgh", 999, new Date().toISOString());
    expect(estimateListTokens([summary])).toBe(2);
  });
});
