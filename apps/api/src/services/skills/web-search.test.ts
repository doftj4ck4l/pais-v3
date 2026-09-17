import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  fetchWithRetry,
  parseArgs,
  searchWeb,
}: {
  fetchWithRetry: (
    url: string,
    timeoutMs: number,
    maxBytes: number,
    headers: Record<string, string>,
    options: SearchOptions,
  ) => Promise<SearchResponse & { attempts: number }>;
  parseArgs: (args: string[]) => { query: string; count: number };
  searchWeb: (query: string, count?: number, options?: SearchOptions) => Promise<string>;
} = require("../../../skills/web-search/web-search.cjs");

type SearchResponse = { status: number; body: string; error: string | null };
type FetchText = (
  url: string,
  timeoutMs: number,
  maxBytes: number,
  headers: Record<string, string>,
) => Promise<SearchResponse>;
type SearchOptions = {
  fetchText: FetchText;
  retryDelays?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
};

const noWait = async () => {};
const rss = (title = "Useful result") =>
  `<rss><channel><item><title>${title}</title><link>https://example.com/result</link></item></channel></rss>`;

describe("web-search skill", () => {
  test("parses a bounded result count", () => {
    expect(parseArgs(["current", "weather", "-n", "3"])).toEqual({
      query: "current weather",
      count: 3,
    });
    expect(parseArgs(["topic"])).toEqual({ query: "topic", count: 8 });
  });

  test("uses Bing RSS first and decodes its result", async () => {
    const urls: string[] = [];
    const fetchText: FetchText = async (url) => {
      urls.push(url);
      return { status: 200, body: rss("Useful &amp; current"), error: null };
    };

    const output = await searchWeb("topic", 4, { fetchText, retryDelays: [], sleep: noWait });

    expect(output).toContain('Search results for "topic" (via Bing):');
    expect(output).toContain("Useful & current");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toStartWith("https://www.bing.com/search?");
  });

  test("retries transient responses before falling back", async () => {
    let attempts = 0;
    const fetchText: FetchText = async () => {
      attempts++;
      if (attempts < 3) return { status: 429, body: "", error: null };
      return { status: 200, body: rss(), error: null };
    };

    const response = await fetchWithRetry("https://example.com", 10, 100, {}, {
      fetchText,
      retryDelays: [0, 0],
      sleep: noWait,
    });

    expect(response.status).toBe(200);
    expect(response.attempts).toBe(3);
  });

  test("falls back to Wikipedia with an identifying user agent", async () => {
    const seen: Array<{ url: string; userAgent: string }> = [];
    const fetchText: FetchText = async (url, _timeout, _bytes, headers) => {
      seen.push({ url, userAgent: headers["user-agent"] ?? "" });
      if (url.includes("bing.com")) return { status: 503, body: "", error: null };
      if (url.includes("wikipedia.org")) {
        return {
          status: 200,
          body: JSON.stringify(["Pixelspace", ["Pixelspace"], [""], ["https://en.wikipedia.org/wiki/Pixelspace"]]),
          error: null,
        };
      }
      throw new Error("DuckDuckGo should not be reached after a successful fallback");
    };

    const output = await searchWeb("what is Pixelspace", 4, {
      fetchText,
      retryDelays: [],
      sleep: noWait,
    });

    expect(output).toContain("(via Wikipedia)");
    const wikipedia = seen.find((request) => request.url.includes("wikipedia.org"));
    expect(wikipedia?.url).toContain("search=Pixelspace");
    expect(wikipedia?.userAgent).toContain("Pixelspace-WebSearch");
  });

  test("reports the actual backend failures instead of calling all of them challenges", async () => {
    const fetchText: FetchText = async (url) => {
      if (url.includes("bing.com")) return { status: 429, body: "", error: null };
      if (url.includes("wikipedia.org")) return { status: 503, body: "", error: null };
      return { status: 202, body: "<title>Are you a robot?</title>", error: null };
    };

    const output = await searchWeb("topic", 8, {
      fetchText,
      retryDelays: [0, 0],
      sleep: noWait,
    });

    expect(output).toStartWith("error: web search is unavailable");
    expect(output).toContain("Bing HTTP 429 after 3 attempts");
    expect(output).toContain("Wikipedia HTTP 503 after 3 attempts");
    expect(output).toContain("DuckDuckGo challenge (HTTP 202)");
    expect(output).toContain("not evidence that the requested information does not exist");
  });

  test("distinguishes an available general search with no matches from backend failure", async () => {
    const fetchText: FetchText = async (url) => {
      if (url.includes("wikipedia.org")) {
        return { status: 200, body: JSON.stringify(["missing", [], [], []]), error: null };
      }
      return { status: 200, body: "<html><body>No matches</body></html>", error: null };
    };

    await expect(
      searchWeb("missing", 8, { fetchText, retryDelays: [], sleep: noWait }),
    ).resolves.toBe('no results for "missing"');
  });
});
