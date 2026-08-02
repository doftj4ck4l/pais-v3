#!/usr/bin/env node
// web-search skill — DuckDuckGo HTML search, no API key.
// Usage: node web-search.js "<query>" [-n <count>]
"use strict";

const https = require("node:https");
const http = require("node:http");

function fetchText(url, timeoutMs, maxBytes) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "user-agent": "Mozilla/5.0" } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), error: null })
        );
      }
    );
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

function cleanUrl(raw) {
  const m = raw.match(/uddg=([^&"]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {}
  }
  return raw.replace(/^\/\//, "https://");
}

// Strip question/instruction phrasing for the Wikipedia fallback so "who is OpenAI"
// becomes "OpenAI".
function cleanQuery(q) {
  const stop = /^(?:search\s+(?:the\s+)?(?:web|internet)(?:\s+(?:for|about))?|search\s+for|tell\s+me\s+(?:about|what|who)|what\s+is|who\s+is|who|what|give\s+me|find|look\s+up|about|info\s+(?:on|about)|information\s+(?:on|about)|on\b|the\b)\s*/i;
  let out = q;
  let prev;
  do {
    prev = out;
    out = out.replace(stop, "").trim();
  } while (out !== prev);
  return out || q;
}

function decodeHtml(s) {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'");
}

const args = process.argv.slice(2);
const nIdx = args.indexOf("-n");
const query = (nIdx >= 0 ? args.slice(0, nIdx) : args).join(" ").trim();
const count = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) || 8 : 8;

if (!query) {
  console.log('usage: node web-search.js "<query>" [-n <count>]');
  process.exit(0);
}

fetchText(
  "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
  12000,
  2000000
).then((res) => {
  if (res.body && res.status === 200) {
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(res.body)) && results.length < count) {
      const title = decodeHtml(m[2].replace(/<[^>]+>/g, "")).trim();
      results.push({ title, url: cleanUrl(m[1]) });
    }
    if (results.length) {
      console.log('Search results for "' + query + '" (via DuckDuckGo):');
      results.forEach((r, i) => console.log(i + 1 + ". " + r.title + "\n   " + r.url));
      return;
    }
  }
  // DuckDuckGo returned a challenge page or nothing — fall back to Wikipedia search.
  fetchText(
    "https://en.wikipedia.org/w/api.php?action=opensearch&search=" +
      encodeURIComponent(cleanQuery(query)) +
      "&limit=" +
      count +
      "&format=json",
    10000,
    200000
  ).then((w) => {
    if (w.error || w.status !== 200) {
      console.log('no results for "' + query + '"');
      return;
    }
    try {
      const [q, titles, , urls] = JSON.parse(w.body);
      if (!titles || !titles.length) {
        console.log('no results for "' + query + '"');
        return;
      }
      console.log('Search results for "' + query + '" (via Wikipedia):');
      titles.forEach((t, i) => console.log(i + 1 + ". " + t + "\n   " + (urls[i] || "")));
    } catch {
      console.log('no results for "' + query + '"');
    }
  });
});
