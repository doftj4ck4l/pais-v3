import { env } from "../../config/env";

const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai/";
const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 10;
const MAX_QUERY_CHARS = 1_000;
const MAX_RESPONSE_BYTES = 256_000;
const REQUEST_TIMEOUT_MS = 10_000;

type TinyfishResult = {
  position?: unknown;
  site_name?: unknown;
  title?: unknown;
  snippet?: unknown;
  url?: unknown;
  date?: unknown;
};

type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type SearchDeps = {
  apiKey?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
};

function oneLine(value: unknown, maxChars: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars)
    : "";
}

function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return JSON.parse(await response.text());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function statusMessage(status: number): string {
  if (status === 401) return "TinyFish authentication failed; check TINYFISH_API_KEY";
  if (status === 402) return "TinyFish Search API access is not enabled for this account";
  if (status === 429) return "TinyFish rate limit was reached; try again shortly";
  if (status === 400) return "TinyFish rejected the search query";
  if (status === 403 || status === 404) return "TinyFish Search API is unavailable for this account";
  if (status >= 500) return "TinyFish Search API is temporarily unavailable";
  return `TinyFish Search API returned HTTP ${status}`;
}

/**
 * Search TinyFish from the API process.
 *
 * The endpoint is fixed and only the query enters its URL. The credential stays
 * in the X-API-Key header here instead of entering a workspace sandbox, a model
 * prompt, a transcript, or a tool result.
 */
export async function searchTinyfish(
  rawQuery: string,
  limit = DEFAULT_RESULT_LIMIT,
  deps: SearchDeps = {},
): Promise<string> {
  const query = rawQuery.trim().replace(/\s+/g, " ");
  if (!query) return "error: web search query is required";
  if (query.length > MAX_QUERY_CHARS) {
    return `error: web search query must be at most ${MAX_QUERY_CHARS} characters`;
  }

  const apiKey = deps.apiKey ?? env.tinyfishApiKey;
  if (!apiKey) return "error: web search is not configured (TINYFISH_API_KEY is unset)";

  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_RESULT_LIMIT;
  const boundedLimit = Math.max(1, Math.min(requestedLimit || DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT));
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("query", query);

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
      signal: deps.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return "error: web search could not reach TinyFish; try again shortly";
  }

  if (!response.ok) return `error: ${statusMessage(response.status)}`;

  let payload: any;
  try {
    payload = await readBoundedJson(response);
  } catch {
    return "error: TinyFish returned an invalid or oversized search response";
  }

  if (!Array.isArray(payload?.results)) {
    return "error: TinyFish returned an invalid search response";
  }

  const results = payload.results
    .map((result: TinyfishResult) => ({
      position: Number.isInteger(result?.position) ? Number(result.position) : null,
      site: oneLine(result?.site_name, 120),
      title: oneLine(result?.title, 300),
      snippet: oneLine(result?.snippet, 1_000),
      url: safeUrl(result?.url),
      date: oneLine(result?.date, 80),
    }))
    .filter((result: { title: string; url: string }) => result.title && result.url)
    .slice(0, boundedLimit);

  if (!results.length) return `no results for "${query}"`;

  const lines = [`Search results for "${query}" (via TinyFish):`];
  results.forEach((result: (typeof results)[number], index: number) => {
    const source = [result.site, result.date].filter(Boolean).join(" · ");
    lines.push(
      `${result.position ?? index + 1}. ${result.title}${source ? ` (${source})` : ""}`,
      ...(result.snippet ? [`   ${result.snippet}`] : []),
      `   ${result.url}`,
    );
  });
  return lines.join("\n");
}

export const tinyfishSearchLimits = {
  queryChars: MAX_QUERY_CHARS,
  responseBytes: MAX_RESPONSE_BYTES,
  results: MAX_RESULT_LIMIT,
} as const;
