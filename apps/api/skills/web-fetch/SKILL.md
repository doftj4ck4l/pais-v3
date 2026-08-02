---
name: web-fetch
description: Fetch a URL over HTTP(S) and return up to ~3000 characters of its visible text content (HTML stripped). Use to read a specific page, article, or search result.
---

# web-fetch

Fetch a URL and extract its visible text. No API key is required.

## How to use

```text
node web-fetch.cjs "https://example.com/article" [maxChars]
```

`maxChars` caps the returned characters (default 3000).

## Output

Prints the page's text content, plain text with tags stripped:

```text
Title: Example Article
https://example.com/article
--------------------------------------------------
The article text follows here...
```

## Errors

Returns `error: ...` when the URL fails, times out, or returns a non-2xx status.
