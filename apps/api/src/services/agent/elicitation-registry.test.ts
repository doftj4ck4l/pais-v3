import { describe, expect, it } from "bun:test";
import {
  answerQuestion,
  cancelQuestion,
  hasQuestion,
  registerQuestion,
} from "./elicitation-registry";

/**
 * The registry is the bridge between the answer endpoint and the paused run.
 * These pin: an answer resolves the exact waiter; an answer for the wrong
 * conversation is refused (tenant isolation); and cancel/answer both clear the
 * entry so a stale reply can't land twice.
 */

describe("elicitation registry", () => {
  it("delivers an answer to the matching waiter", () => {
    const got: { v: string | null } = { v: null };
    registerQuestion("q1", "conv1", (a) => (got.v = a));
    expect(hasQuestion("q1")).toBe(true);

    expect(answerQuestion("conv1", "q1", "Google Calendar")).toBe(true);
    expect(got.v).toBe("Google Calendar");
    // Cleared, so a second answer cannot re-fire the resolver.
    expect(hasQuestion("q1")).toBe(false);
    expect(answerQuestion("conv1", "q1", "again")).toBe(false);
  });

  it("refuses an answer from a different conversation", () => {
    const got: { v: string | null } = { v: null };
    registerQuestion("q2", "conv-owner", (a) => (got.v = a));

    expect(answerQuestion("conv-other", "q2", "sneaky")).toBe(false);
    expect(got.v).toBeNull();
    // Still waiting for its real owner.
    expect(hasQuestion("q2")).toBe(true);
    expect(answerQuestion("conv-owner", "q2", "ok")).toBe(true);
    expect(got.v).toBe("ok");
  });

  it("reports nothing waiting for an unknown question", () => {
    expect(answerQuestion("conv1", "nope", "x")).toBe(false);
  });

  it("cancel drops the waiter so it can no longer be answered", () => {
    registerQuestion("q3", "conv1", () => {});
    cancelQuestion("q3");
    expect(hasQuestion("q3")).toBe(false);
    expect(answerQuestion("conv1", "q3", "x")).toBe(false);
  });
});
