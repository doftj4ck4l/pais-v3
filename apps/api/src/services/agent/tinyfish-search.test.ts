import { describe, expect, test } from "bun:test";
import { searchTinyfish, tinyfishSearchLimits } from "./tinyfish-search";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("TinyFish web search", () => {
  test("uses the fixed Search API endpoint and keeps the key in its header", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    const output = await searchTinyfish("  current   malaysia news  ", 8, {
      apiKey: "test-secret-key",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedHeaders = new Headers(init?.headers);
        return jsonResponse({
          results: [
            {
              position: 1,
              site_name: "example.com",
              title: "Current news",
              snippet: "A useful summary.",
              url: "https://example.com/news",
              date: "2026-09-19",
            },
          ],
        });
      },
    });

    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://api.search.tinyfish.ai/");
    expect(url.searchParams.get("query")).toBe("current malaysia news");
    expect(requestedHeaders.get("X-API-Key")).toBe("test-secret-key");
    expect(requestedHeaders.get("Accept")).toBe("application/json");
    expect(requestedUrl).not.toContain("test-secret-key");
    expect(output).toContain('Search results for "current malaysia news" (via TinyFish):');
    expect(output).toContain("1. Current news (example.com · 2026-09-19)");
    expect(output).toContain("A useful summary.");
    expect(output).toContain("https://example.com/news");
  });

  test("bounds results and strips control characters from provider text", async () => {
    const results = Array.from({ length: 12 }, (_, index) => ({
      position: index + 1,
      site_name: "example.com",
      title: `Result\n${index + 1}`,
      snippet: `Snippet\u0000 ${index + 1}`,
      url: `https://example.com/${index + 1}`,
    }));
    const output = await searchTinyfish("topic", 99, {
      apiKey: "key",
      fetchImpl: async () => jsonResponse({ results }),
    });

    expect(output).toContain("Result 1");
    expect(output).toContain("Snippet 1");
    expect(output).toContain("https://example.com/10");
    expect(output).not.toContain("https://example.com/11");
    expect(output).not.toContain("\u0000");
  });

  test("drops malformed and non-http result URLs", async () => {
    const output = await searchTinyfish("topic", 8, {
      apiKey: "key",
      fetchImpl: async () =>
        jsonResponse({
          results: [
            { title: "Script", url: "javascript:alert(1)" },
            { title: "Broken", url: "not a URL" },
            { title: "Safe", url: "https://example.com/path" },
          ],
        }),
    });

    expect(output).toContain("Safe");
    expect(output).not.toContain("Script");
    expect(output).not.toContain("Broken");
  });

  test("returns no-results only for a valid empty result set", async () => {
    await expect(
      searchTinyfish("missing", 8, {
        apiKey: "key",
        fetchImpl: async () => jsonResponse({ results: [] }),
      }),
    ).resolves.toBe('no results for "missing"');

    await expect(
      searchTinyfish("broken", 8, {
        apiKey: "key",
        fetchImpl: async () => jsonResponse({ result: [] }),
      }),
    ).resolves.toBe("error: TinyFish returned an invalid search response");
  });

  test("rejects missing and oversized queries before making a request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ results: [] });
    });

    expect(await searchTinyfish("  ", 8, { apiKey: "key", fetchImpl })).toBe(
      "error: web search query is required",
    );
    expect(
      await searchTinyfish("x".repeat(tinyfishSearchLimits.queryChars + 1), 8, {
        apiKey: "key",
        fetchImpl,
      }),
    ).toContain(`at most ${tinyfishSearchLimits.queryChars} characters`);
    expect(calls).toBe(0);
  });

  test("fails closed when the server credential is absent", async () => {
    let called = false;
    const output = await searchTinyfish("topic", 8, {
      apiKey: "",
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ results: [] });
      },
    });

    expect(output).toBe("error: web search is not configured (TINYFISH_API_KEY is unset)");
    expect(called).toBe(false);
  });

  test("classifies provider failures without returning its body or the key", async () => {
    const secret = "test-key-that-must-not-leak";
    for (const [status, message] of [
      [401, "authentication failed"],
      [402, "access is not enabled"],
      [429, "rate limit"],
      [503, "temporarily unavailable"],
    ] as const) {
      const output = await searchTinyfish("topic", 8, {
        apiKey: secret,
        fetchImpl: async () => new Response(`upstream echoed ${secret}`, { status }),
      });
      expect(output).toContain(message);
      expect(output).not.toContain(secret);
      expect(output).not.toContain("upstream echoed");
    }
  });

  test("does not expose network errors or secrets", async () => {
    const secret = "network-secret";
    const output = await searchTinyfish("topic", 8, {
      apiKey: secret,
      fetchImpl: async () => {
        throw new Error(`socket failed with ${secret}`);
      },
    });

    expect(output).toBe("error: web search could not reach TinyFish; try again shortly");
    expect(output).not.toContain(secret);
  });

  test("rejects malformed and oversized successful responses", async () => {
    await expect(
      searchTinyfish("topic", 8, {
        apiKey: "key",
        fetchImpl: async () => new Response("not json"),
      }),
    ).resolves.toBe("error: TinyFish returned an invalid or oversized search response");

    await expect(
      searchTinyfish("topic", 8, {
        apiKey: "key",
        fetchImpl: async () => new Response("x".repeat(tinyfishSearchLimits.responseBytes + 1)),
      }),
    ).resolves.toBe("error: TinyFish returned an invalid or oversized search response");
  });
});
