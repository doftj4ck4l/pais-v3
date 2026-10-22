/**
 * Lens.org MCP server.
 *
 * A thin stdio bridge between the agent and the Lens REST API. The API key is
 * read from LENS_API_KEY, which the connector form stores encrypted in the MCP
 * server row. Nothing is written to stdout except MCP frames; diagnostics go to
 * stderr so the connector's probe can show them.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = "https://api.lens.org";
const KEY = process.env.LENS_API_KEY?.trim() ?? "";
if (!KEY) {
  console.error("LENS_API_KEY is required");
  process.exit(1);
}

type Json = Record<string, unknown>;

const SCHOLAR_INCLUDE = [
  "lens_id",
  "title",
  "publication_type",
  "year_published",
  "date_published",
  "external_ids",
  "authors",
  "source",
  "fields_of_study",
  "abstract",
  "author_count",
];

const PATENT_INCLUDE = [
  "lens_id",
  "jurisdiction",
  "doc_number",
  "kind",
  "date_published",
  "biblio",
  "abstract",
  "publication_type",
];

async function lens(path: string, body: Json): Promise<Json> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lens API ${res.status}: ${text.slice(0, 600)}`);
  }
  return JSON.parse(text) as Json;
}

function authorsOf(row: Json): string[] {
  const authors = Array.isArray(row.authors) ? row.authors : [];
  return authors
    .slice(0, 8)
    .map((author: any) =>
      author?.display_name ||
      [author?.first_name, author?.last_name].filter(Boolean).join(" "),
    )
    .filter(Boolean);
}

function doiOf(row: Json): string | null {
  const ids = Array.isArray(row.external_ids) ? row.external_ids : [];
  const doi = ids.find((id: any) => id?.type === "doi");
  return typeof doi?.value === "string" ? doi.value : null;
}

function truncate(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

function scholarRow(row: Json) {
  const source = (row.source ?? {}) as Json;
  return {
    lens_id: row.lens_id ?? null,
    title: row.title ?? null,
    year: row.year_published ?? null,
    date: row.date_published ?? null,
    type: row.publication_type ?? null,
    doi: doiOf(row),
    authors: authorsOf(row),
    source: source.title ?? null,
    publisher: source.publisher ?? null,
    fields_of_study: row.fields_of_study ?? null,
    abstract: truncate(row.abstract, 1200),
  };
}

function patentTitle(row: Json): string | null {
  const biblio = (row.biblio ?? {}) as Json;
  const titles = Array.isArray(biblio.invention_title) ? biblio.invention_title : [];
  const text = titles
    .map((title: any) => title?.text)
    .filter(Boolean)
    .join(" ");
  return text || null;
}

function patentRow(row: Json) {
  const biblio = (row.biblio ?? {}) as Json;
  const parties = (biblio.parties ?? {}) as Json;
  const applicants = Array.isArray(parties.applicants) ? parties.applicants : [];
  return {
    lens_id: row.lens_id ?? null,
    title: patentTitle(row),
    jurisdiction: row.jurisdiction ?? null,
    doc_number: row.doc_number ?? null,
    kind: row.kind ?? null,
    date: row.date_published ?? null,
    type: row.publication_type ?? null,
    abstract: truncate(row.abstract, 1200),
    applicants: applicants
      .slice(0, 5)
      .map((applicant: any) => applicant?.name)
      .filter(Boolean),
  };
}

function searchBody(query: string, size: number, from: number, sort: string, include: string[], patent = false) {
  const body: Json = { query, size, from, include };
  if (sort === "newest") body.sort = [{ [patent ? "date_published" : "year_published"]: "desc" }];
  else if (sort === "oldest") body.sort = [{ [patent ? "date_published" : "year_published"]: "asc" }];
  return body;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

const server = new Server(
  { name: "lens", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_scholarly",
      description:
        "Search Lens.org scholarly works (papers, books, conference proceedings). Returns titles, authors, years, DOIs, sources and abstracts.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text query, e.g. 'artificial intelligence Malaysia'." },
          size: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          from: { type: "integer", minimum: 0, default: 0 },
          sort: { type: "string", enum: ["relevance", "newest", "oldest"], default: "relevance" },
        },
        required: ["query"],
      },
    },
    {
      name: "search_patents",
      description:
        "Search Lens.org patents. Returns titles, jurisdictions, publication numbers, dates and abstracts.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text query, e.g. 'artificial intelligence Malaysia'." },
          size: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          from: { type: "integer", minimum: 0, default: 0 },
          sort: { type: "string", enum: ["relevance", "newest", "oldest"], default: "relevance" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_scholarly",
      description: "Fetch one Lens.org scholarly work by Lens ID or DOI.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          lens_id: { type: "string", description: "Lens ID, e.g. 180-434-188-130-70X." },
          doi: { type: "string", description: "DOI, e.g. 10.1109/scored68498.2025.11399233." },
        },
      },
    },
    {
      name: "get_patent",
      description: "Fetch one Lens.org patent by Lens ID.",
      annotations: READ_ONLY,
      inputSchema: {
        type: "object",
        properties: {
          lens_id: { type: "string", description: "Lens ID." },
        },
        required: ["lens_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: raw } = request.params;
  const args = (raw ?? {}) as Record<string, unknown>;
  try {
    if (name === "search_scholarly" || name === "search_patents") {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const size = Math.min(Math.max(Number(args.size ?? 5), 1), 10);
      const from = Math.max(Number(args.from ?? 0), 0);
      const sort = String(args.sort ?? "relevance");

      if (name === "search_scholarly") {
        const data = await lens(
          "/scholarly/search",
          searchBody(query, size, from, sort, SCHOLAR_INCLUDE),
        );
        const rows = (Array.isArray(data.data) ? data.data : []).map((row: Json) => scholarRow(row));
        return {
          content: [
            { type: "text", text: JSON.stringify({ total: data.total ?? null, results: rows }, null, 2) },
          ],
        };
      }

      const data = await lens(
        "/patent/search",
        searchBody(query, size, from, sort, PATENT_INCLUDE, true),
      );
      const rows = (Array.isArray(data.data) ? data.data : []).map((row: Json) => patentRow(row));
      return {
        content: [
          { type: "text", text: JSON.stringify({ total: data.total ?? null, results: rows }, null, 2) },
        ],
      };
    }

    if (name === "get_scholarly") {
      const lensId = String(args.lens_id ?? "").trim();
      const doi = String(args.doi ?? "").trim();
      if (!lensId && !doi) throw new Error("lens_id or doi is required");
      const query = lensId ? { terms: { lens_id: [lensId] } } : { match: { doi } };
      const data = await lens("/scholarly/search", {
        query,
        size: 1,
        include: SCHOLAR_INCLUDE,
      });
      const row = Array.isArray(data.data) && data.data[0] ? scholarRow(data.data[0]) : null;
      return { content: [{ type: "text", text: JSON.stringify({ result: row }, null, 2) }] };
    }

    if (name === "get_patent") {
      const lensId = String(args.lens_id ?? "").trim();
      if (!lensId) throw new Error("lens_id is required");
      const data = await lens("/patent/search", {
        query: { terms: { lens_id: [lensId] } },
        size: 1,
        include: PATENT_INCLUDE,
      });
      const row = Array.isArray(data.data) && data.data[0] ? patentRow(data.data[0]) : null;
      return { content: [{ type: "text", text: JSON.stringify({ result: row }, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Lens error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
