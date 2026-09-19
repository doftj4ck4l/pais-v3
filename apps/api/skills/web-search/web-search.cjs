#!/usr/bin/env node
// Keyless web search with bounded, observable fallbacks.
// Usage: node web-search.cjs "<query>" [-n <count>]
"use strict";

const https = require("node:https");
const http = require("node:http");

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Wikimedia asks API clients to identify the application rather than imitate a
// browser. A generic browser UA was measured receiving intermittent HTTP 429s.
const WIKIPEDIA_UA = "Pixelspace-WebSearch/1.0 (https://pixel-space.co)";
const RETRY_DELAYS_MS = [200, 600];
const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "about", "cari", "dan", "find", "for", "info", "information",
  "mengenai", "of", "on", "search", "tentang", "the", "untuk", "what", "who",
]);

function fetchText(url, timeoutMs, maxBytes, headers = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          error: null,
        }),
      );
    });
    req.on("error", (error) =>
      resolve({ status: 0, body: "", error: error.code || error.message || "request failed" }),
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

function shouldRetry(response) {
  return (
    response.status === 0 ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  );
}

async function fetchWithRetry(url, timeoutMs, maxBytes, headers, options = {}) {
  const request = options.fetchText ?? fetchText;
  const delays = options.retryDelays ?? RETRY_DELAYS_MS;
  const wait = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let response = await request(url, timeoutMs, maxBytes, headers);
  let attempts = 1;
  for (const delay of delays) {
    if (!shouldRetry(response)) break;
    await wait(delay);
    response = await request(url, timeoutMs, maxBytes, headers);
    attempts++;
  }
  return { ...response, attempts };
}

function challengePage(response) {
  if (response.status === 202) return true;
  return /<title>[^<]*(captcha|unusual traffic|are you a robot)|challenge-form|cf-challenge/i.test(
    response.body.slice(0, 4_000),
  );
}

function unavailable(name, response) {
  if (challengePage(response)) {
    return { name, state: "unavailable", detail: `${name} challenge (HTTP ${response.status})` };
  }
  if (response.error) {
    const reason = String(response.error).replace(/[^a-z0-9 .:_-]/gi, "").slice(0, 80);
    return {
      name,
      state: "unavailable",
      detail: `${name} network error${reason ? ` (${reason})` : ""} after ${response.attempts} attempts`,
    };
  }
  return {
    name,
    state: "unavailable",
    detail: `${name} HTTP ${response.status} after ${response.attempts} attempts`,
  };
}

function decodeHtml(value) {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'");
}

function decodeXml(value) {
  return decodeHtml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function cleanUrl(raw) {
  const match = raw.match(/uddg=([^&"]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {}
  }
  return raw.replace(/^\/\//, "https://");
}

// Wikipedia is a factual fallback, so remove instruction phrasing that makes
// its opensearch endpoint miss an otherwise obvious entity name.
function cleanQuery(query) {
  const stop =
    /^(?:search\s+(?:the\s+)?(?:web|internet)(?:\s+(?:for|about))?|search\s+for|tell\s+me\s+(?:about|what|who)|what\s+is|who\s+is|who|what|give\s+me|find|look\s+up|about|info\s+(?:on|about)|information\s+(?:on|about)|on\b|the\b)\s*/i;
  let output = query;
  let previous;
  do {
    previous = output;
    output = output.replace(stop, "").trim();
  } while (output !== previous);
  return output || query;
}

/**
 * Bing's RSS endpoint sometimes returns a healthy 200 containing results for a
 * completely different query. That is worse than an unavailable backend: the
 * agent trusts the titles, fetches them, and spends the run chasing unrelated
 * pages. Keep only results that contain enough meaningful query terms. This is
 * deliberately applied to Bing rather than every backend because DuckDuckGo
 * was measured returning the right Nextplus pages while Bing returned YouTube
 * help and Chinese hospital pages for the same request.
 */
function relevantBingResults(query, results) {
  const terms = [...new Set(
    cleanQuery(query)
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 2 && !QUERY_STOP_WORDS.has(term)) ?? [],
  )];
  if (!terms.length) return results;
  const required = terms.length >= 3 ? 2 : 1;
  return results.filter((result) => {
    const haystack = `${result.title} ${result.url}`.toLocaleLowerCase("en-US");
    return terms.filter((term) => haystack.includes(term)).length >= required;
  });
}

async function bingSearch(query, count, options) {
  const response = await fetchWithRetry(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${count}`,
    5_000,
    2_000_000,
    { "user-agent": BROWSER_UA, accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.1" },
    options,
  );
  if (response.status !== 200 || response.error || challengePage(response)) {
    return unavailable("Bing", response);
  }

  const results = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(response.body)) && results.length < count) {
    const title = tag(match[1], "title");
    const url = tag(match[1], "link");
    if (!title || !url || /^bing:/i.test(title)) continue;
    results.push({ title, url });
  }
  const relevant = relevantBingResults(query, results);
  if (results.length && !relevant.length) {
    return {
      name: "Bing",
      state: "unavailable",
      detail: "Bing returned results unrelated to the query",
      results: [],
    };
  }
  return { name: "Bing", state: relevant.length ? "results" : "empty", results: relevant };
}

async function wikipediaSearch(query, count, options) {
  const response = await fetchWithRetry(
    "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(cleanQuery(query)) +
      `&srlimit=${count}&format=json`,
    5_000,
    200_000,
    { "user-agent": WIKIPEDIA_UA, accept: "application/json" },
    options,
  );
  if (response.status !== 200 || response.error) return unavailable("Wikipedia", response);
  try {
    const parsed = JSON.parse(response.body);
    const results = (parsed?.query?.search ?? [])
      .map((match) => ({
        title: typeof match?.title === "string" ? match.title : "",
        url: Number.isInteger(match?.pageid)
          ? `https://en.wikipedia.org/?curid=${match.pageid}`
          : "",
      }))
      .filter((result) => result.title && result.url)
      .slice(0, count);
    return { name: "Wikipedia", state: results.length ? "results" : "empty", results };
  } catch {
    return {
      name: "Wikipedia",
      state: "unavailable",
      detail: "Wikipedia returned invalid JSON",
    };
  }
}

async function duckDuckGoSearch(query, count, options) {
  const response = await fetchWithRetry(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    5_000,
    2_000_000,
    { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" },
    options,
  );
  if (response.status !== 200 || response.error || challengePage(response)) {
    return unavailable("DuckDuckGo", response);
  }

  const results = [];
  const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultPattern.exec(response.body)) && results.length < count) {
    const title = decodeHtml(match[2].replace(/<[^>]+>/g, "")).trim();
    if (title) results.push({ title, url: cleanUrl(match[1]) });
  }
  return { name: "DuckDuckGo", state: results.length ? "results" : "empty", results };
}

function renderResults(query, outcome) {
  const lines = [`Search results for "${query}" (via ${outcome.name}):`];
  outcome.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}\n   ${result.url}`);
  });
  return lines.join("\n");
}

async function searchWeb(query, count = 8, options = {}) {
  const boundedCount = Math.max(1, Math.min(Number.parseInt(count, 10) || 8, 10));
  // DuckDuckGo is both the documented primary backend and the one measured
  // returning relevant results from production. Wikipedia is a precise entity
  // fallback. Bing RSS remains last because it can answer the wrong query with
  // a syntactically valid feed; relevantBingResults guards that final path.
  const backends = [duckDuckGoSearch, wikipediaSearch, bingSearch];
  const unavailableBackends = [];
  let generalSearchReturnedEmpty = false;

  for (const backend of backends) {
    const outcome = await backend(query, boundedCount, options);
    if (outcome.state === "results") return renderResults(query, outcome);
    if (outcome.state === "unavailable") unavailableBackends.push(outcome.detail);
    if (outcome.state === "empty" && outcome.name !== "Wikipedia") {
      generalSearchReturnedEmpty = true;
    }
  }

  if (generalSearchReturnedEmpty) return `no results for "${query}"`;
  return (
    `error: web search is unavailable — ${unavailableBackends.join("; ")}. ` +
    "This is a backend failure, not evidence that the requested information does not exist."
  );
}

function parseArgs(argv) {
  const countIndex = argv.indexOf("-n");
  const query = (countIndex >= 0 ? argv.slice(0, countIndex) : argv).join(" ").trim();
  const count = countIndex >= 0 ? Number.parseInt(argv[countIndex + 1], 10) || 8 : 8;
  return { query, count };
}

async function main() {
  const { query, count } = parseArgs(process.argv.slice(2));
  if (!query) {
    console.log('usage: node web-search.cjs "<query>" [-n <count>]');
    return;
  }
  console.log(await searchWeb(query, count));
}

module.exports = {
  bingSearch,
  challengePage,
  cleanQuery,
  duckDuckGoSearch,
  fetchWithRetry,
  parseArgs,
  relevantBingResults,
  searchWeb,
  shouldRetry,
  wikipediaSearch,
};

if (require.main === module) void main();
