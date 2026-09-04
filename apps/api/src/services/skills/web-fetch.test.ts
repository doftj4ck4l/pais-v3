import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  extractReadableHtml,
  fetchReadablePage,
  parseRequest,
  renderPage,
}: {
  extractReadableHtml: (html: string) => { title: string; text: string };
  fetchReadablePage: (
    request: { url: string; maxChars: number },
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  ) => Promise<string>;
  parseRequest: (
    argv: string[],
  ) => { url: string; maxChars: number; error?: undefined } | { error: string };
  renderPage: (page: {
    requestedUrl: string;
    finalUrl: string;
    contentType: string;
    body: string;
    bodyTruncated: boolean;
    maxChars: number;
  }) => string;
} = require("../../../skills/web-fetch/web-fetch.cjs");

describe("web-fetch", () => {
  test("accepts direct and JSON requests while bounding output size", () => {
    expect(parseRequest(["https://example.com/story"])).toEqual({
      url: "https://example.com/story",
      maxChars: 12_000,
    });
    expect(
      parseRequest([JSON.stringify({ url: "https://example.com/story", maxChars: 99_999 })]),
    ).toEqual({ url: "https://example.com/story", maxChars: 20_000 });
    expect(parseRequest(["file:///etc/passwd"])).toEqual({
      error: "error: fetch_url needs an absolute HTTP(S) URL",
    });
  });

  test("keeps article text and removes scripts, styles, and page chrome", () => {
    const paragraph = "The useful article sentence has enough detail for the agent to answer. ".repeat(5);
    const page = `<!doctype html>
      <html><head>
        <title>Useful &amp; readable</title>
        <meta name="description" content="A concise summary.">
        <style>.secret { display: none }</style>
        <script>window.secret = "ignore me"</script>
      </head><body>
        <header>Site-wide banner</header><nav>One Two Three</nav>
        <article><h1>Story heading</h1><p>${paragraph}</p><ul><li>First fact</li></ul></article>
        <footer>Cookie settings</footer>
      </body></html>`;

    const result = extractReadableHtml(page);
    expect(result.title).toBe("Useful & readable");
    expect(result.text).toContain("A concise summary.");
    expect(result.text).toContain("Story heading");
    expect(result.text).toContain("- First fact");
    expect(result.text).not.toContain("window.secret");
    expect(result.text).not.toContain("Site-wide banner");
    expect(result.text).not.toContain("Cookie settings");
  });

  test("prefers structured articleBody metadata when publishers provide it", () => {
    const articleBody = "Structured article copy ".repeat(20).trim();
    const page = `<html><head><title>Report</title>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        articleBody,
      })}</script></head><body><main>${"Navigation and promos ".repeat(30)}</main></body></html>`;

    expect(extractReadableHtml(page).text).toBe(articleBody);
  });

  test("renders bounded readable content with an explicit truncation note", () => {
    const output = renderPage({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/story",
      contentType: "text/html",
      body: `<html><head><title>Story</title></head><body><main>${"Article text. ".repeat(200)}</main></body></html>`,
      bodyTruncated: false,
      maxChars: 1_000,
    });

    expect(output).toContain("Title: Story");
    expect(output).toContain("Requested URL: https://example.com/start");
    expect(output).toContain("Article text.");
    expect(output).toContain("[Output truncated: showing 1,000 of");
    expect(output).not.toContain("<main>");
  });

  test("recognises HTML by its doctype when a server omits Content-Type", () => {
    const output = renderPage({
      requestedUrl: "https://example.com/story",
      finalUrl: "https://example.com/story",
      contentType: "",
      body: `<!doctype html><html><head><title>Untyped page</title></head><body><main>${"Readable copy. ".repeat(30)}</main></body></html>`,
      bodyTruncated: false,
      maxChars: 12_000,
    });

    expect(output).toContain("Title: Untyped page");
    expect(output).toContain("Readable copy.");
    expect(output).not.toContain("<!doctype html>");
  });

  test("formats JSON and turns HTTP failures into explicit errors", async () => {
    const jsonFetch = async () =>
      new Response('{"answer":42}', {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    const forbiddenFetch = async () => new Response("no", { status: 403 });

    await expect(
      fetchReadablePage({ url: "https://example.com/data", maxChars: 12_000 }, jsonFetch),
    ).resolves.toContain('"answer": 42');
    await expect(
      fetchReadablePage({ url: "https://example.com/private", maxChars: 12_000 }, forbiddenFetch),
    ).resolves.toBe("error: fetch_url returned HTTP 403");
  });
});
