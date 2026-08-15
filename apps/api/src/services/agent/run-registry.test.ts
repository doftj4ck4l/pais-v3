import { describe, expect, it } from "bun:test";
import { abortRun, registerRun, unregisterRun } from "./run-registry";

/**
 * The registry is the bridge between the stop endpoint and the running pi loop.
 * These pin the two behaviours that make it correct: aborting fires the exact
 * controller registered for a conversation, and a stale `finally` cannot
 * unregister a fresh run that reused the same conversation id.
 */

describe("run registry", () => {
  it("aborts the controller registered for a conversation", () => {
    const controller = new AbortController();
    registerRun("conv-1", controller);
    expect(controller.signal.aborted).toBe(false);

    const stopped = abortRun("conv-1");
    expect(stopped).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports nothing running for an unknown or finished conversation", () => {
    expect(abortRun("nope")).toBe(false);
  });

  it("does not abort across conversations", () => {
    const a = new AbortController();
    const b = new AbortController();
    registerRun("conv-a", a);
    registerRun("conv-b", b);

    abortRun("conv-a");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    unregisterRun("conv-a", a);
    unregisterRun("conv-b", b);
  });

  it("unregister only clears the entry when it is still the current controller", () => {
    const first = new AbortController();
    const second = new AbortController();
    registerRun("conv-x", first);
    // A follow-up turn replaces the controller before the first turn's finally.
    registerRun("conv-x", second);

    // The first turn's finally must not unregister the live second run.
    unregisterRun("conv-x", first);
    expect(abortRun("conv-x")).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
    unregisterRun("conv-x", second);
  });

  it("a cleared run can no longer be stopped", () => {
    const controller = new AbortController();
    registerRun("conv-done", controller);
    unregisterRun("conv-done", controller);
    expect(abortRun("conv-done")).toBe(false);
  });
});
