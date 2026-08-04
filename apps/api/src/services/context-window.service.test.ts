import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../types/chat";
import {
  COMPACT_AT,
  RESERVE_TOKENS,
  applyCompaction,
  estimateHistoryTokens,
  estimateTokens,
  planCompaction,
  usableWindow,
} from "./context-window.service";

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });

/** A turn pair of roughly `chars` characters. */
const turn = (n: number, chars = 400): ChatMessage[] => [
  user(`Q${n} ` + "x".repeat(chars)),
  assistant(`A${n} ` + "y".repeat(chars)),
];

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
