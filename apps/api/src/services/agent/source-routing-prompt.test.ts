import { describe, expect, test } from "bun:test";
import { sourceRoutingPrompt } from "./source-routing-prompt";

describe("sourceRoutingPrompt", () => {
  test("routes NextPlus questions through its official website", () => {
    const prompt = sourceRoutingPrompt(["fetch_url", "web_search"]);

    expect(prompt).toContain("what the NextPlus system is");
    expect(prompt).toContain('"site:nextplus.com.my NextPlus system"');
    expect(prompt).toContain('call "fetch_url"');
    expect(prompt).toContain("primary context");
    expect(prompt).toContain("cite the official URL");
    expect(prompt).toContain("do not answer this question from memory");
  });

  test("does not instruct a run to call unavailable web tools", () => {
    expect(sourceRoutingPrompt([])).toBe("");
    expect(sourceRoutingPrompt(["fetch_url"])).toBe("");
    expect(sourceRoutingPrompt(["web_search"])).toBe("");
  });
});
