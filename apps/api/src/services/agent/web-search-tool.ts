import { Type } from "@earendil-works/pi-ai";
import { createWebSearchRunner } from "./web-search-runtime";
import { searchTinyfish } from "./tinyfish-search";

type Search = (query: string) => Promise<string>;

/**
 * Build the first-class web search tool.
 *
 * Keep this tool registered even when TinyFish is not configured. Otherwise a
 * missing or late-mounted secret silently changes the model's tool set and
 * leaves only fetch_url visible. searchTinyfish already returns a safe,
 * actionable configuration error without exposing the credential.
 */
export function createWebSearchTool(search: Search = searchTinyfish) {
  const runSearch = createWebSearchRunner(search);

  return {
    name: "web_search",
    description:
      "Search the web with TinyFish and return result titles, snippets, and URLs. Use this for " +
      "current or external information, then read a promising result with fetch_url.",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1_000 }) }),
    label: "web_search",
    execute: async (_id: string, params: any) => {
      const out = await runSearch(String(params?.query ?? ""));
      return { content: [{ type: "text" as const, text: out }], details: { output: out } };
    },
  };
}
