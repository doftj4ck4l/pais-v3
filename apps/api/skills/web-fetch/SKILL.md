---
name: web-fetch
description: Low-level page reader used by the first-class fetch_url tool. Prefer fetch_url so errors and arguments are traced correctly.
---

# web-fetch

Fetch a URL and extract its useful visible text. No API key is required. The
`fetch_url` tool wraps this skill and is the normal model-facing interface.

## How to use

```text
node web-fetch.cjs "https://example.com/article" [maxChars]
```

`maxChars` caps the returned page text (default 12000, maximum 20000). The
script also accepts one JSON argument with `url` and `maxChars`, which is how
the `fetch_url` tool calls it.

## Output

Prints the page's title and useful text. For HTML, script, style, navigation,
header, footer, and other page chrome are removed before the result is capped:

```text
Title: Example Article
URL: https://example.com/article
Content-Type: text/html
----------------------------------------
The article text follows here...
```

## Errors

Returns `error: ...` when the URL fails, times out, or returns a non-2xx status.
