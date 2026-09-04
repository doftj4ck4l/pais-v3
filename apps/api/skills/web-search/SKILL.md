---
name: web-search
description: Search the web (DuckDuckGo, no API key) and return a list of result titles and URLs. Use when you need live, current, or factual information from the open web.
usage: a plain-text search query (optionally end with -n <count> to cap results, default 8)
---

# web-search

Search the open web using DuckDuckGo's HTML endpoint. No API key is required.

## How to use

Run the skill with a search query:

```text
node web-search.cjs "malaysia gdp 2026" -n 8
```

The `-n <count>` flag caps the number of results (default 8).

## Output

The skill prints numbered results with the page title and the URL:

```text
Search results for "malaysia gdp 2026":
1. Malaysia GDP 2026 | Trading Economics
   https://tradingeconomics.com/malaysia/gdp
...
```

Use the URL from a result with the `fetch_url` tool to read the page content.
