import { describe, expect, test } from "bun:test";
import { createWebSearchTool } from "./web-search-tool";

describe("web search tool", () => {
  test("is registered independently of provider configuration", async () => {
    const searches: string[] = [];
    const tool = createWebSearchTool(async (query) => {
      searches.push(query);
      return `results for ${query}`;
    });

    expect(tool.name).toBe("web_search");
    expect(tool.label).toBe("web_search");
    expect(tool.description).toContain("TinyFish");

    await expect(tool.execute("call-1", { query: "latest news" })).resolves.toEqual({
      content: [{ type: "text", text: "results for latest news" }],
      details: { output: "results for latest news" },
    });
    expect(searches).toEqual(["latest news"]);
  });

  test("surfaces a safe provider error instead of removing the tool", async () => {
    const tool = createWebSearchTool(async () =>
      "error: web search is not configured (TINYFISH_API_KEY is unset)"
    );

    const result = await tool.execute("call-1", { query: "anything" });
    expect(result.details.output).toBe(
      "error: web search is not configured (TINYFISH_API_KEY is unset)",
    );
  });
});
