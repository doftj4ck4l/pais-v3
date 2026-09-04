#!/usr/bin/env node
"use strict";

const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 20_000;
const MAX_BODY_BYTES = 5_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

const BLOCK_TAGS =
  /<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|figcaption|figure|footer|h[1-6]|header|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul)\b[^>]*>/gi;

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, key) => {
    if (key[0] === "#") {
      const hex = key[1]?.toLowerCase() === "x";
      const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return entity;
        }
      }
      return entity;
    }
    return named[key.toLowerCase()] ?? entity;
  });
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function metadata(html, wanted) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "name") || attribute(tag, "property");
    if (wanted.includes(key.toLowerCase())) return attribute(tag, "content");
  }
  return "";
}

function removePageChrome(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:script|style|noscript|svg|template|canvas|iframe)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template|canvas|iframe)>/gi, " ")
    .replace(/<(?:nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|form|dialog)>/gi, " ");
}

function markupToText(html) {
  return decodeEntities(
    removePageChrome(html)
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/?(?:td|th)\b[^>]*>/gi, "\t")
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function jsonLdArticleBodies(html) {
  const bodies = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.articleBody === "string") bodies.push(value.articleBody.trim());
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(match[1].trim()));
    } catch {
      // Publishers frequently put non-JSON JavaScript in this block. The DOM
      // candidates below still recover the article, so malformed metadata is
      // not a page failure.
    }
  }
  return bodies;
}

function tagBodies(html, tagName) {
  const blocks = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const text = markupToText(match[1]);
    if (text) blocks.push(text);
  }
  return blocks;
}

function extractReadableHtml(html) {
  const rawTitle = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const title = markupToText(rawTitle) || metadata(html, ["og:title", "twitter:title"]);
  const description = metadata(html, ["description", "og:description", "twitter:description"]);
  const longest = (values) =>
    values.filter((text) => text.length >= 200).sort((a, b) => b.length - a.length)[0];
  // A publisher-authored articleBody is more precise than a visually large
  // <main>, which often includes recommendations and promos after the story.
  // Keep length as the tie-breaker only within the same semantic tier.
  let text =
    longest(jsonLdArticleBodies(html)) ??
    longest(tagBodies(html, "article")) ??
    longest(tagBodies(html, "main")) ??
    markupToText(html);
  if (description && !text.toLowerCase().includes(description.toLowerCase())) {
    text = `${description}\n\n${text}`;
  }
  return { title, text };
}

function parseRequest(argv) {
  let url = String(argv[0] ?? "").trim();
  let requestedMax = Number(argv[1] ?? DEFAULT_MAX_CHARS);
  if (url.startsWith("{")) {
    try {
      const parsed = JSON.parse(url);
      url = String(parsed?.url ?? "").trim();
      requestedMax = Number(parsed?.maxChars ?? DEFAULT_MAX_CHARS);
    } catch {
      return { error: "error: fetch_url received invalid arguments" };
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: "error: fetch_url needs an absolute HTTP(S) URL" };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { error: "error: fetch_url needs an absolute HTTP(S) URL" };
  }
  if (!Number.isFinite(requestedMax)) requestedMax = DEFAULT_MAX_CHARS;
  const maxChars = Math.min(MAX_MAX_CHARS, Math.max(1_000, Math.floor(requestedMax)));
  return { url: parsedUrl.href, maxChars };
}

async function readBounded(response, maxBytes = MAX_BODY_BYTES) {
  if (!response.body) return { body: "", truncated: false, bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      body += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
      bytes = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    bytes += value.byteLength;
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return { body, truncated, bytes };
}

function renderPage({ requestedUrl, finalUrl, contentType, body, bodyTruncated, maxChars }) {
  const html =
    /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) ||
    /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body);
  let title = "";
  let text;
  if (html) {
    ({ title, text } = extractReadableHtml(body));
  } else if (/\b(?:application\/(?:[\w.+-]*\+)?json|text\/json)\b/i.test(contentType)) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      text = body.trim();
    }
  } else if (/^text\//i.test(contentType) || !contentType) {
    text = body.trim();
  } else {
    return `error: fetch_url cannot read non-text content (${contentType || "unknown content type"})`;
  }

  if (!text) return "error: fetch_url found no readable text on the page";
  const totalChars = text.length;
  const shown = text.slice(0, maxChars).trimEnd();
  const header = [
    title ? `Title: ${title}` : null,
    `URL: ${finalUrl || requestedUrl}`,
    finalUrl && finalUrl !== requestedUrl ? `Requested URL: ${requestedUrl}` : null,
    `Content-Type: ${contentType || "unknown"}`,
    "----------------------------------------",
  ].filter(Boolean);
  const notes = [];
  if (totalChars > maxChars) {
    notes.push(`[Output truncated: showing ${shown.length.toLocaleString()} of ${totalChars.toLocaleString()} readable characters.]`);
  }
  if (bodyTruncated) {
    notes.push(`[Download stopped at ${(MAX_BODY_BYTES / 1_000_000).toFixed(0)} MB before extraction.]`);
  }
  return `${header.join("\n")}\n${shown}${notes.length ? `\n\n${notes.join("\n")}` : ""}`;
}

async function fetchReadablePage(request, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(request.url, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `error: fetch_url request failed (${reason})`;
  }
  if (!response.ok) return `error: fetch_url returned HTTP ${response.status}`;

  let downloaded;
  try {
    downloaded = await readBounded(response);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `error: fetch_url could not read the response (${reason})`;
  }
  return renderPage({
    requestedUrl: request.url,
    finalUrl: response.url,
    contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "",
    body: downloaded.body,
    bodyTruncated: downloaded.truncated,
    maxChars: request.maxChars,
  });
}

async function main() {
  const request = parseRequest(process.argv.slice(2));
  if (request.error) {
    console.log(request.error);
    return;
  }
  console.log(await fetchReadablePage(request));
}

module.exports = {
  decodeEntities,
  extractReadableHtml,
  fetchReadablePage,
  markupToText,
  parseRequest,
  readBounded,
  renderPage,
};

if (require.main === module) void main();
