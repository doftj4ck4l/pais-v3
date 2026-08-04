import {
  databaseConnectionStore,
  type DatabaseConnectionStore,
  type TableDetail,
} from "../repositories/database-connection.repository";
import { toFtsQuery } from "./search.service";
import { BYTE_CAP, ROW_CAP, runReadOnly, scrub, type QueryOutcome } from "./db/postgres.driver";

/**
 * The agent's three database tools, bound to one user's connections.
 *
 * They are tiered on purpose. The system prompt carries table *names* only;
 * `search_schema` narrows a question to candidates, `describe_table` produces the
 * exact columns and foreign keys a correct query needs, and only then does
 * `run_query` execute. Loading full schema up front would work for ten tables and
 * fail for a thousand.
 *
 * Tools take a connection *name*, never a URL. The credential is resolved inside
 * the repository and never enters a prompt, a tool result, or a transcript — so a
 * prompt-injected document cannot ask the agent to reveal it.
 */

type Execute = typeof runReadOnly;

export function createDatabaseTools(
  userId: string,
  store: DatabaseConnectionStore = databaseConnectionStore,
  execute: Execute = runReadOnly,
): any[] {
  /**
   * Resolve a connection name to its row, or explain what is available.
   * Deliberately does not decrypt anything — `store.list` returns only the
   * public columns. `describe_table` and `search_schema` call only this, so
   * a plaintext connection string never enters memory on a path that never
   * uses it.
   */
  async function resolveConnection(name: string) {
    const trimmed = String(name ?? "").trim();
    const connections = await store.list(userId);
    const known = connections.map((c) => c.name);

    if (!trimmed) {
      return { ok: false as const, message: known.length
        ? `which database? available: ${known.join(", ")}`
        : "no databases are connected" };
    }
    const hit = connections.find((c) => c.name === trimmed);
    if (!hit) {
      return { ok: false as const, message: known.length
        ? `unknown database "${trimmed}" — available: ${known.join(", ")}`
        : "no databases are connected" };
    }
    return { ok: true as const, row: hit };
  }

  /**
   * Decrypt the URL for an already-resolved connection. Split out from
   * `resolveConnection` so only `run_query` — the one tool that actually
   * executes SQL — ever puts a plaintext connection string in memory.
   */
  async function resolveUrl(row: { id: string; name: string }) {
    const url = await store.resolveUrl(userId, row.id);
    if (!url) return { ok: false as const, message: `unknown database "${row.name}"` };
    return { ok: true as const, url };
  }

  return [
    {
      name: "search_schema",
      label: "search_schema",
      description:
        "Find tables and columns in the connected databases by keyword. " +
        "Use this first when you do not already know which table holds what you need. " +
        "Returns ranked matches; follow up with describe_table before writing SQL.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "what to look for, e.g. 'refund' or 'customer email'" },
          connection: { type: "string", description: "limit to one database by name (optional)" },
          limit: { type: "integer", description: "max matches, default 10" },
        },
        required: ["query"],
      },
      async execute(_id: string, params: any) {
        const raw = String(params?.query ?? "").trim();
        const ftsQuery = toFtsQuery(raw);
        if (!ftsQuery) return text(`no searchable terms in "${raw}" — try different wording`);

        const connection = params?.connection ? String(params.connection) : null;
        const limit = Math.max(1, Math.min(50, Number(params?.limit ?? 10) || 10));
        const hits = await store.searchSchema(userId, ftsQuery, connection, limit);

        if (!hits.length) {
          const inv = await store.inventory(userId);
          if (!inv.length) return text("no schema is available — no databases are connected");
          return text(
            `no schema matched "${raw}". Databases: ` +
              inv.map((c) => `${c.name} (${c.tableCount} tables)`).join(", ") +
              `. Try different wording.`,
          );
        }

        const body = hits
          .map((h) =>
            h.columnName
              ? `${h.connectionName}.${h.tableName}.${h.columnName} — ${h.detail}`
              : `${h.connectionName}.${h.tableName} (table) — ${h.detail}`,
          )
          .join("\n");
        return text(`${hits.length} match(es) for "${raw}":\n\n${body}`);
      },
    },

    {
      name: "describe_table",
      label: "describe_table",
      description:
        "Full structure of one table: columns, types, nullability, primary key, " +
        "foreign keys, indexes, and approximate row count. " +
        "Call this before writing SQL against a table — it is the only way to get " +
        "exact column names and the foreign keys a correct join needs. " +
        "Returns structure only, never data.",
      parameters: {
        type: "object",
        properties: {
          connection: { type: "string", description: "database name" },
          table: { type: "string", description: "table name, bare or schema-qualified" },
        },
        required: ["connection", "table"],
      },
      async execute(_id: string, params: any) {
        const found = await resolveConnection(params?.connection);
        if (!found.ok) return text(found.message);

        const table = String(params?.table ?? "").trim();
        const detail = await store.describeTable(userId, found.row.name, table);
        if (!detail) {
          const inv = await store.inventory(userId);
          const names = inv.find((c) => c.name === found.row.name)?.tables ?? [];
          return text(
            `no table "${table}" in ${found.row.name}. ` +
              (names.length ? `Tables: ${names.join(", ")}` : "This database has no tables."),
          );
        }
        return text(renderTable(detail));
      },
    },

    {
      name: "run_query",
      label: "run_query",
      description:
        "Run one read-only SQL SELECT against a connected database. " +
        `At most ${ROW_CAP} rows are returned and the statement is cancelled after 10 seconds, ` +
        "so aggregate in SQL rather than fetching rows and counting them yourself. " +
        "Only SELECT, WITH, and EXPLAIN are permitted.",
      parameters: {
        type: "object",
        properties: {
          connection: { type: "string", description: "database name" },
          sql: { type: "string", description: "one SELECT statement" },
          limit: { type: "integer", description: `max rows, at most ${ROW_CAP}` },
        },
        required: ["connection", "sql"],
      },
      async execute(_id: string, params: any) {
        const found = await resolveConnection(params?.connection);
        if (!found.ok) return text(found.message);

        const statement = String(params?.sql ?? "").trim();
        if (!statement) return text("error: sql required");

        // Only run_query ever decrypts a connection string — it is the only
        // one of the three tools that actually needs it.
        const resolved = await resolveUrl(found.row);
        if (!resolved.ok) return text(resolved.message);

        // No clamping here: the driver's `boundCap` is the single authority
        // on what a caller-supplied limit is allowed to mean (see
        // postgres.driver.ts). `?? ROW_CAP` substitutes a default only when
        // `limit` is genuinely absent — unlike `||`, it does not also
        // (mis)treat an explicit `limit: 0` as "no limit given".
        const cap = Number(params?.limit ?? ROW_CAP);
        const outcome = await execute(resolved.url, statement, cap);
        // `runReadOnly` already scrubs its own errors, but this is the last
        // point before the text reaches the model — scrub again defensively
        // rather than trust every executor implementation to have done it.
        const safe: QueryOutcome = outcome.ok
          ? outcome
          : { ok: false, error: scrub(outcome.error, resolved.url) };
        return text(renderOutcome(safe, cap));
      },
    },
  ];
}

function renderTable(detail: TableDetail): string {
  // Ambiguity warning goes first: a bare name like "orders" can match tables in
  // more than one schema, and if the agent doesn't see this before the column
  // list it will confidently write SQL against whichever schema we happened to
  // pick. Naming the *other* schemas is what lets it re-ask with a qualified
  // name if this wasn't the one it wanted.
  const ambiguity = detail.alternateSchemas.length
    ? `NOTE: "${detail.name}" is ambiguous — also exists in: ${detail.alternateSchemas.join(", ")}. ` +
      `Showing ${detail.schemaName}.${detail.name}. To describe a different one, qualify it, e.g. ` +
      `${detail.alternateSchemas[0]}.${detail.name}.\n\n`
    : "";

  const head =
    `${detail.schemaName}.${detail.name}` +
    (detail.comment ? ` — ${detail.comment}` : "") +
    `\n~${detail.rowEstimate.toLocaleString("en-US")} rows\n`;

  const columns = detail.columns
    .map((c) => {
      const flags = [
        c.isPrimaryKey ? "PK" : null,
        c.nullable ? null : "NOT NULL",
        c.fkTable ? `FK -> ${c.fkTable}.${c.fkColumn}` : null,
      ].filter(Boolean);
      return (
        `  ${c.name}  ${c.dataType}` +
        (flags.length ? `  [${flags.join(", ")}]` : "") +
        (c.comment ? `  -- ${c.comment}` : "")
      );
    })
    .join("\n");

  const indexes = detail.indexes.length
    ? `\n\nIndexes:\n${detail.indexes.map((i) => `  ${i}`).join("\n")}`
    : "";

  return `${ambiguity}${head}\nColumns:\n${columns}${indexes}`;
}

/**
 * Postgres's own wording for a `statement_timeout` cancellation. Detected here
 * (rather than in the driver) because the guidance that follows is about how
 * the *agent* should change its next call — a tool-layer concern, same as the
 * truncation advice below.
 */
const STATEMENT_TIMEOUT_PATTERN = /statement timeout/i;

function renderQueryError(error: string): string {
  if (STATEMENT_TIMEOUT_PATTERN.test(error)) {
    return (
      `${error} — this query was cancelled for taking too long. Re-running it unchanged ` +
      "will time out again. Aggregate in SQL (COUNT/SUM/GROUP BY), add a WHERE filter to " +
      "narrow it, or select fewer rows instead."
    );
  }
  return error;
}

/**
 * Truncation has two independent causes with different fixes, so the advice
 * has to name which one fired: too many ROWS means aggregate instead of
 * fetching everything; too many BYTES means the shown rows themselves are too
 * wide (a large text/json/bytea column) and no amount of aggregating rows
 * helps — the query needs fewer columns or a `left(col, n)` wrapper.
 *
 * A `reason` of `undefined` (an outcome built by hand rather than by the
 * driver, e.g. in older tests) falls back to the row-cap wording, which was
 * this function's only message before the byte budget existed.
 */
function truncationNote(reason: "rows" | "bytes" | null | undefined, cap: number): string {
  if (reason === "bytes") {
    return (
      `(truncated: this result exceeds the ${BYTE_CAP.toLocaleString("en-US")}-byte budget. ` +
      "Select fewer columns, or wrap a wide column with left(col, n), rather than re-running as-is.)"
    );
  }
  return `(showing the first ${cap} rows — more exist. Aggregate in SQL rather than paginating.)`;
}

function renderOutcome(outcome: QueryOutcome, cap: number): string {
  if (!outcome.ok) return `query failed: ${renderQueryError(outcome.error)}`;
  if (!outcome.rows.length) return "no rows";

  const header = outcome.columns.join(" | ");
  const body = outcome.rows
    .map((r) => outcome.columns.map((c) => format(r[c])).join(" | "))
    .join("\n");
  const note = outcome.truncated ? `\n\n${truncationNote(outcome.truncatedReason, cap)}` : "";

  return `${header}\n${"-".repeat(header.length)}\n${body}${note}`;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  // A real SQL NULL renders as the bare word NULL above. A string value that
  // happens to *be* the text "NULL" (any case) would otherwise render
  // identically and be indistinguishable to the agent, so only that
  // collision case gets quoted — every other string stays unquoted and
  // readable.
  const str = String(value);
  if (str.toUpperCase() === "NULL") return `"${str}"`;
  return str;
}

function text(out: string) {
  return { content: [{ type: "text" as const, text: out }], details: { output: out } };
}
