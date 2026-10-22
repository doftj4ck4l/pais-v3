/**
 * Arkib document app MCP server.
 *
 * A read-only bridge to the document-agent API: list documents, keyword and
 * semantic search, page text, full OCR text, and PDF links. Credentials come
 * from the connector form (ARKIB_URL / ARKIB_USERNAME / ARKIB_PASSWORD) and are
 * stored encrypted by Pixelspace.
 *
 * The app rotates its da_session cookie on responses, so every response is
 * checked for a replacement and the latest value is sent on the next call.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.ARKIB_URL?.trim() || "http://10.21.48.62:8887").replace(/\/+$/, "");
const USERNAME = process.env.ARKIB_USERNAME?.trim() || "admin";
const PASSWORD = process.env.ARKIB_PASSWORD ?? "";
if (!PASSWORD) {
  console.error("ARKIB_PASSWORD is required");
  process.exit(1);
}

type Json = Record<string, unknown>;
let cookie: string | null = null;

function captureCookie(res: Response): void {
  const raw = res.headers.get("set-cookie");
  if (!raw) return;
  const match = raw.match(/da_session=[^;]+/);
  if (match) cookie = match[0];
}

async function login(): Promise<void> {
  cookie = null;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Arkib login ${res.status}: ${text.slice(0, 400)}`);
  captureCookie(res);
  if (!cookie) throw new Error("Arkib login returned no da_session cookie");
}

async function request(path: string): Promise<Response> {
  if (!cookie) await login();
  const send = () =>
    fetch(`${BASE}${path}`, {
      headers: { Cookie: cookie ?? "" },
    });
  let res = await send();
  if (res.status === 401) {
    await login();
    res = await send();
  }
  captureCookie(res);
  return res;
}

async function getJson(path: string): Promise<Json> {
  const res = await request(path);
  const text = await res.text();
  if (!res.ok) throw new Error(`Arkib ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as Json;
}

async function getText(path: string): Promise<string> {
  const res = await request(path);
  const text = await res.text();
  if (!res.ok) throw new Error(`Arkib ${res.status}: ${text.slice(0, 400)}`);
  return text;
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function requiredString(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

const server = new Server(
  { name: "arkib", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_documents",
      description:
        "List documents in the Arkib archive, newest first. Returns titles, page counts and text/OCR coverage.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
    {
      name: "search_keyword",
      description:
        "Keyword/BM25 search across the Arkib OCR corpus. Returns matching documents, pages and snippets.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for." },
          k: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
        required: ["query"],
      },
    },
    {
      name: "search_semantic",
      description:
        "Semantic/vector search across the Arkib corpus. Better than keyword search for concepts and paraphrases.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language question or concept." },
          k: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
        required: ["query"],
      },
    },
    {
      name: "get_document",
      description: "Fetch metadata for one Arkib document by id.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: { document_id: { type: "integer", minimum: 1 } },
        required: ["document_id"],
      },
    },
    {
      name: "get_page_text",
      description: "Read the OCR text of one page of an Arkib document.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          document_id: { type: "integer", minimum: 1 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["document_id", "page"],
      },
    },
    {
      name: "get_document_text",
      description:
        "Read the full OCR text of an Arkib document, with page markers. Truncated at max_chars.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          document_id: { type: "integer", minimum: 1 },
          max_chars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 },
        },
        required: ["document_id"],
      },
    },
    {
      name: "download_pdf",
      description: "Get the download URL for an Arkib document's original PDF.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: { document_id: { type: "integer", minimum: 1 } },
        required: ["document_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: raw } = request.params;
  const args = (raw ?? {}) as Record<string, unknown>;
  try {
    if (name === "list_documents") {
      const limit = numberArg(args.limit, 20, 1, 50);
      const offset = numberArg(args.offset, 0, 0, 1_000_000);
      const data = await getJson(`/api/documents?limit=${limit}&offset=${offset}`);
      const rows = (Array.isArray(data.rows) ? data.rows : []).map((row: any) => ({
        id: row.id,
        title: row.title,
        filename: row.original_filename ?? null,
        pages: row.page_count ?? null,
        text_pages: row.text_pages ?? null,
        empty_pages: row.empty_pages ?? null,
        created_at: row.created_at ?? null,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: data.total ?? null, has_more: data.has_more ?? null, documents: rows }, null, 2),
          },
        ],
      };
    }

    if (name === "search_keyword" || name === "search_semantic") {
      const query = requiredString(args.query, "query");
      const k = numberArg(args.k, 5, 1, 10);
      const offset = numberArg(args.offset, 0, 0, 1_000_000);
      const path =
        name === "search_keyword"
          ? `/api/search/keyword?q=${encodeURIComponent(query)}&k=${k}&offset=${offset}`
          : `/api/search/semantic?q=${encodeURIComponent(query)}&k=${k}&offset=${offset}`;
      const data = await getJson(path);
      const hits = (Array.isArray(data.hits) ? data.hits : []).map((hit: any) => ({
        document_id: hit.document_id ?? null,
        document_title: hit.document_title ?? null,
        page: hit.page_number ?? null,
        page_id: hit.page_id ?? null,
        snippet: hit.snippet ?? null,
        score: hit.bm25_score ?? hit.score ?? hit.cosine ?? null,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ query, total: data.total ?? null, hits }, null, 2),
          },
        ],
      };
    }

    if (name === "get_document") {
      const documentId = numberArg(args.document_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (!documentId) throw new Error("document_id is required");
      const data = await getJson(`/api/documents/${documentId}`);
      return { content: [{ type: "text", text: JSON.stringify({ document: data }, null, 2) }] };
    }

    if (name === "get_page_text") {
      const documentId = numberArg(args.document_id, 0, 1, Number.MAX_SAFE_INTEGER);
      const page = numberArg(args.page, 0, 1, Number.MAX_SAFE_INTEGER);
      if (!documentId) throw new Error("document_id is required");
      if (!page) throw new Error("page is required");
      const data = await getJson(`/api/documents/${documentId}/pages/${page}/snippet`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                document_id: data.document_id ?? documentId,
                page_number: data.page_number ?? page,
                text: data.text ?? "",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "get_document_text") {
      const documentId = numberArg(args.document_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (!documentId) throw new Error("document_id is required");
      const maxChars = numberArg(args.max_chars, 20000, 1000, 50000);
      const text = await getText(`/api/documents/${documentId}/download.txt`);
      const truncated = text.length > maxChars;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                document_id: documentId,
                truncated,
                total_chars: text.length,
                text: truncated ? `${text.slice(0, maxChars).trimEnd()}…` : text,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "download_pdf") {
      const documentId = numberArg(args.document_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (!documentId) throw new Error("document_id is required");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                document_id: documentId,
                url: `${BASE}/api/documents/${documentId}/download`,
                note: "Open this URL in the Arkib app; it requires an Arkib session.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Arkib error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
