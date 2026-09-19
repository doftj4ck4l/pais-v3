import { describe, expect, test } from "bun:test";
import { createWebSearchRunner } from "./web-search-runtime";

describe("web-search runtime", () => {
  test("serializes different queries across runners", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const invoke = async (query: string) => {
      calls.push(query);
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (query === "first") await firstBlocked;
      active--;
      return `results:${query}`;
    };

    const firstRunner = createWebSearchRunner(invoke);
    const secondRunner = createWebSearchRunner(invoke);
    const first = firstRunner("first");
    await Promise.resolve();
    const second = secondRunner("second");
    await Promise.resolve();

    expect(calls).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
    expect(maximumActive).toBe(1);
  });

  test("deduplicates in-flight calls and caches successful output", async () => {
    let calls = 0;
    const runner = createWebSearchRunner(async () => {
      calls++;
      return "Search results";
    });

    const [first, second] = await Promise.all([runner(" same   query "), runner("same query")]);
    expect(first).toBe("Search results");
    expect(second).toBe("Search results");
    expect(await runner("same query")).toBe("Search results");
    expect(calls).toBe(1);
  });

  test("does not cache a transient provider failure", async () => {
    let calls = 0;
    const runner = createWebSearchRunner(async () => {
      calls++;
      return calls === 1 ? "error: backend returned HTTP 429" : "Search results";
    });

    expect(await runner("query")).toStartWith("error:");
    expect(await runner("query")).toBe("Search results");
    expect(calls).toBe(2);
  });
});
