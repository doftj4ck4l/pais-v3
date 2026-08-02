#!/usr/bin/env node
// web-fetch skill — fetch a URL and strip HTML to visible text.
// Usage: node web-fetch.js "https://url" [maxChars]
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

function stripHtml(raw) {
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const noScript = raw.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const args = process.argv.slice(2);
const url = (args[0] || "").trim();
const maxChars = parseInt(args[1], 10) || 3000;

if (!/^https?:\/\/.+/i.test(url)) {
  console.log("error: must provide an absolute http(s) URL");
  process.exit(0);
}

fetchText(url, 15000, 3_000_000).then((res) => {
  if (res.error) {
    console.log("error: request failed (" + res.error + ")");
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    console.log("error: HTTP " + res.status);
    return;
  }
  const title = (res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const text = stripHtml(res.body);
  const out =
    (title ? "Title: " + title.replace(/<[^>]+>/g, "").trim() + "\n" : "") +
    url +
    "\n--------------------------------------------------\n" +
    text;
  console.log(out.slice(0, maxChars));
});
