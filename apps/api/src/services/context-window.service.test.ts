import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../types/chat";
import {
  COMPACT_AT,
  RESERVE_TOKENS,
  KEEP_TOOL_RESULTS,
  applyCompaction,
  estimateHistoryTokens,
  estimateTokens,
  planCompaction,
  pruneToolResults,
  usableWindow,
} from "./context-window.service";

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });

/** A turn pair of roughly `chars` characters. */
const turn = (n: number, chars = 400): ChatMessage[] => [
  user(`Q${n} ` + "x".repeat(chars)),
  assistant(`A${n} ` + "y".repeat(chars)),
];

const toolMsg = (n: number, chars = 4000): ChatMessage => ({
  role: "tool",
  name: `t${n}`,
  tool_call_id: `call_${n}`,
  content: "z".repeat(chars),
});

describe("pruneToolResults", () => {
  it("does nothing when there are few enough tool results", () => {
    const history = [user("q"), toolMsg(1), toolMsg(2)];
    const out = pruneToolResults(history);
    expect(out.pruned).toBe(0);
    expect(out.saved).toBe(0);
    expect(out.history).toBe(history);
  });

  it("prunes the oldest and keeps the most recent", () => {
    const history = [user("q"), ...Array.from({ length: 10 }, (_, i) => toolMsg(i))];
    const out = pruneToolResults(history);

    expect(out.pruned).toBe(10 - KEEP_TOOL_RESULTS);
    expect(out.saved).toBeGreaterThan(0);

    const tools = out.history.filter((m) => m.role === "tool");
    const intact = tools.filter((m) => (m.content ?? "").length > 100);
    expect(intact).toHaveLength(KEEP_TOOL_RESULTS);
    // The kept ones must be the LAST six, not any six.
    expect(intact.map((m) => m.name)).toEqual(["t4", "t5", "t6", "t7", "t8", "t9"]);
  });

  it("keeps the message in place so no tool call is left dangling", () => {
    // Deleting a tool result whose tool_call_id is still referenced makes
    // providers reject the whole request, so only the payload may go.
    const history = [user("q"), ...Array.from({ length: 8 }, (_, i) => toolMsg(i))];
    const out = pruneToolResults(history);

    expect(out.history).toHaveLength(history.length);
    const first = out.history[1]!;
    expect(first.role).toBe("tool");
    expect(first.tool_call_id).toBe("call_0");
    expect(first.content).toContain("removed to fit");
  });

  it("reclaims a real amount of the budget", () => {
    const history = Array.from({ length: 12 }, (_, i) => toolMsg(i, 40_000));
    const before = estimateHistoryTokens(history);
    const out = pruneToolResults(history);
    const after = estimateHistoryTokens(out.history);
    // Six of twelve results survive, so a little over half remains — the point
    // is that the reclaim is real and equals what the function reported.
    expect(after).toBeLessThan(before * 0.55);
    expect(out.saved).toBe(before - after);
  });
});

describe("planCompaction with real occupancy", () => {
  it("compacts on the real number when the estimate alone would not", () => {
    // The exact failure the meter exposed: the estimate sees only the chat
    // history, so a thread sitting at 90% of a real window reads as "fine".
    const window = 123_072;
    const history = Array.from({ length: 60 }, (_, i) => turn(i, 2_000)).flat();

    const estimated = estimateHistoryTokens(history);
    expect(estimated).toBeLessThan(usableWindow(window) * COMPACT_AT);
    expect(planCompaction(history, window)).toBeNull();

    const plan = planCompaction(history, window, 110_000);
    expect(plan).not.toBeNull();
    expect(plan!.tokensBefore).toBe(110_000);
    expect(plan!.summarise.length).toBeGreaterThan(0);
  });

  it("declines to compact when the history is not what is filling the window", () => {
    // A short thread against an MCP workspace: the occupancy is tool schemas,
    // which no amount of summarising can shrink. Returning null is correct —
    // summarising the only two messages present would cost a model call and
    // reclaim nothing.
    const history = [...turn(1, 100), user("one more short question")];
    expect(planCompaction(history, 123_072, 110_000)).toBeNull();
  });

  it("ignores a real number that is smaller than the estimate", () => {
    // The real figure is from the PREVIOUS turn; the history has grown since.
    // Whichever is larger is the honest answer.
    const history = Array.from({ length: 40 }, (_, i) => turn(i, 2_000)).flat();
    const estimated = estimateHistoryTokens(history);
    const plan = planCompaction(history, 30_000, 10);
    expect(plan).not.toBeNull();
    expect(plan!.tokensBefore).toBe(estimated);
  });

  it("still returns null when the real number is comfortably under budget", () => {
    const history = [...turn(1, 100)];
    expect(planCompaction(history, 123_072, 1_000)).toBeNull();
  });
});

describe("estimateTokens", () => {
  it("scales with content length", () => {
    expect(estimateTokens(user("x".repeat(400)))).toBeGreaterThan(
      estimateTokens(user("x".repeat(40))),
    );
  });

  it("counts tool calls, not just text", () => {
    const bare = { role: "assistant" as const, content: "" };
    const withCall: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "1", type: "function", function: { name: "search_docs", arguments: '{"query":"x"}' } },
      ],
    };
    expect(estimateTokens(withCall)).toBeGreaterThan(estimateTokens(bare));
  });

  it("charges per-message overhead so many small messages are not free", () => {
    const many = Array.from({ length: 20 }, () => user("hi"));
    expect(estimateHistoryTokens(many)).toBeGreaterThanOrEqual(20 * 4);
  });
});

describe("usableWindow", () => {
  it("reserves room for the reply", () => {
    expect(usableWindow(100_000)).toBe(100_000 - RESERVE_TOKENS);
  });

  it("never returns a negative budget for a tiny window", () => {
    expect(usableWindow(10)).toBeGreaterThan(0);
  });
});

describe("planCompaction", () => {
  it("returns null while the thread still fits", () => {
    expect(planCompaction([user("short question")], 100_000)).toBeNull();
  });

  it("triggers once past the threshold", () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(i, 1000)).flat();
    const window = 12_000; // usable 4000, threshold 3200
    const tokens = estimateHistoryTokens(history);
    expect(tokens).toBeGreaterThan(usableWindow(window) * COMPACT_AT);

    const plan = planCompaction(history, window);
    expect(plan).not.toBeNull();
    expect(plan!.summarise.length).toBeGreaterThan(0);
    expect(plan!.keep.length).toBeGreaterThan(0);
    expect(plan!.tokensBefore).toBe(tokens);
  });

  it("keeps the newest turn — the question being asked", () => {
    const history = [...Array.from({ length: 40 }, (_, i) => turn(i, 1000)).flat(), user("FINAL")];
    const plan = planCompaction(history, 12_000);
    expect(plan).not.toBeNull();
    expect(plan!.keep.at(-1)!.content).toBe("FINAL");
  });

  it("cuts at a user message so a turn is never split from its reply", () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(i, 1000)).flat();
    const plan = planCompaction(history, 12_000);
    expect(plan).not.toBeNull();
    expect(plan!.keep[0]!.role).toBe("user");
  });

  it("loses no messages — summarise plus keep is the whole history", () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(i, 1000)).flat();
    const plan = planCompaction(history, 12_000)!;
    expect(plan.summarise.length + plan.keep.length).toBe(history.length);
    expect([...plan.summarise, ...plan.keep]).toEqual(history);
  });

  it("declines when only the current oversized turn exists", () => {
    // Nothing older to summarise: compacting would eat the live question.
    const history = [user("x".repeat(200_000))];
    expect(planCompaction(history, 12_000)).toBeNull();
  });

  it("shrinks the thread it is given", () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(i, 1000)).flat();
    const plan = planCompaction(history, 12_000)!;
    const after = estimateHistoryTokens(applyCompaction(plan, "a short summary"));
    expect(after).toBeLessThan(plan.tokensBefore);
  });
});

describe("applyCompaction", () => {
  it("puts the summary first and keeps the recent tail in order", () => {
    const plan = { summarise: [user("old")], keep: [user("recent"), user("newest")], tokensBefore: 1 };
    const out = applyCompaction(plan, "SUMMARY TEXT");
    expect(out[0]!.content).toContain("SUMMARY TEXT");
    expect(out[0]!.role).toBe("user");
    expect(out.at(-1)!.content).toBe("newest");
    expect(out.at(-2)!.content).toBe("recent");
  });

  it("labels the summary so the model does not read it as the user's words", () => {
    const plan = { summarise: [user("old")], keep: [user("q")], tokensBefore: 1 };
    expect(applyCompaction(plan, "s")[0]!.content).toContain("Summary of the earlier conversation");
  });
});
