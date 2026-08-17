import {
  databaseConnectionStore,
  type DatabaseConnectionStore,
  type TableDetail,
} from "../../repositories/database-connection.repository";
import { toFtsQuery } from "../documents/search.service";
import {
  redactDatabaseError,
  type DatabaseConnectionConfig,
  type DatabaseError,
  type QueryOutcome,
} from "./database-adapter";
import { databaseConnector } from "./database-connector.service";
import { DATABASE_BYTE_CAP, DATABASE_ROW_CAP } from "./query-policy";

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

type Execute = (
  config: DatabaseConnectionConfig,
  sql: string,
  cap?: number,
) => Promise<QueryOutcome>;

type DatabaseTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: unknown): Promise<ReturnType<typeof text>>;
};

type DatabaseCapability = { tools: DatabaseTool[]; prompt: string };

const DATABASE_INVENTORY_TABLE_LIMIT = 60;

function limitedInventory(entry: { tables: string[]; tableCount: number }) {
  const tables = entry.tables.slice(0, DATABASE_INVENTORY_TABLE_LIMIT);
  return { tables, remaining: Math.max(0, entry.tableCount - tables.length) };
}

/**
 * Load database access from the resources attached to this workspace.
 *
 * Database access is a capability of the one agent, not a separate agent
 * personality. Empty workspaces keep these tool schemas and their prompt out
 * of the model context entirely.
 */
export async function loadDatabaseCapability(
  workspaceId: string,
  store: DatabaseConnectionStore = databaseConnectionStore,
): Promise<DatabaseCapability> {
  const inventory = await store.inventory(workspaceId);
  if (!inventory.length) return { tools: [], prompt: "" };

  const connections = inventory
    .map((connection) => {
      const { tables, remaining } = limitedInventory(connection);
      return (
        `- "${connection.name}" — ${connection.tableCount} table(s): ${tables.join(", ")}` +
        (remaining ? `, … (${remaining} more — use search_schema)` : "")
      );
    })
    .join("\n");

  const prompt = `

Connected databases:
${connections}

Use the read-only database tools whenever the user asks about one of these databases:
1. If you do not know which table holds the answer, call "search_schema".
2. Call "describe_table" on every table you intend to query. These are table names
   only; never guess columns or joins.
3. Call "run_query" with one SELECT, WITH, or EXPLAIN statement.

Queries are read-only, capped, and cancelled after 10 seconds. Aggregate in SQL
instead of fetching rows to count them. When answering, name the tables used and
show the SQL you ran.`;

  return { tools: createDatabaseTools(workspaceId, store), prompt };
}

export function createDatabaseTools(
  workspaceId: string,
  store: DatabaseConnectionStore = databaseConnectionStore,
  execute: Execute = (config, sql, cap) => databaseConnector.executeReadOnly(config, sql, cap),
): DatabaseTool[] {
  /**
   * Resolve a connection name to its row, or explain what is available.
   * Deliberately does not decrypt anything — `store.list` returns only the
   * public columns. `describe_table` and `search_schema` call only this, so
   * a plaintext connection string never enters memory on a path that never
   * uses it.
   */
  async function resolveConnection(name: string) {
    const trimmed = String(name ?? "").trim();
    const connections = await store.list(workspaceId);
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
   * Decrypt the configuration for an already-resolved connection. Split out from
   * `resolveConnection` so only `run_query` — the one tool that actually
   * executes SQL — ever puts a plaintext password in memory.
   */
  async function resolveConfig(row: { id: string; name: string }) {
    const config = await store.resolveConfig(workspaceId, row.id);
    if (!config) return { ok: false as const, message: `unknown database "${row.name}"` };
    return { ok: true as const, config };
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
          query: { type: "string", description: "what to look for; omit to list schemas and tables" },
          connection: { type: "string", description: "limit to one database by name (optional)" },
          limit: { type: "integer", description: "max matches, default 10" },
        },
        required: [],
      },
      async execute(_id: string, params: any) {
        const raw = String(params?.query ?? "").trim();
        if (!raw) {
          const connection = params?.connection ? String(params.connection).trim() : null;
          const inventory = (await store.inventory(workspaceId)).filter(
            (entry) => !connection || entry.name === connection,
          );
          if (!inventory.length) return text(connection ? `unknown database "${connection}"` : "no databases are connected");
          return text(
            inventory
              .map((entry) => {
                const { tables, remaining } = limitedInventory(entry);
                const shown = tables.map((table) => `  ${table}`).join("\n");
                const continuation = remaining
                  ? `\n  ... (${remaining} more - use search_schema with a query)`
                  : "";
                return `${entry.name} (${entry.tableCount} tables)\n${shown}${continuation}`;
              })
              .join("\n\n"),
          );
        }
        const ftsQuery = toFtsQuery(raw);
        if (!ftsQuery) return text(`no searchable terms in "${raw}" — try different wording`);

        const connection = params?.connection ? String(params.connection) : null;
        const limit = Math.max(1, Math.min(50, Number(params?.limit ?? 10) || 10));
        const hits = await store.searchSchema(workspaceId, ftsQuery, connection, limit);

        if (!hits.length) {
          const inv = await store.inventory(workspaceId);
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
              ? `${h.connectionName}.${h.schemaName}.${h.tableName}.${h.columnName} — ${h.detail}`
              : `${h.connectionName}.${h.schemaName}.${h.tableName} (table) — ${h.detail}`,
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
        const detail = await store.describeTable(workspaceId, found.row.name, table);
        if (!detail) {
          const inv = await store.inventory(workspaceId);
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
        `At most ${DATABASE_ROW_CAP} rows are returned and the statement is cancelled after 10 seconds, ` +
        "so aggregate in SQL rather than fetching rows and counting them yourself. " +
        "Only SELECT, WITH, and EXPLAIN are permitted.",
      parameters: {
        type: "object",
        properties: {
          connection: { type: "string", description: "database name" },
          sql: { type: "string", description: "one SELECT statement" },
          limit: { type: "integer", description: `max rows, at most ${DATABASE_ROW_CAP}` },
        },
        required: ["connection", "sql"],
      },
      async execute(_id: string, params: any) {
        const found = await resolveConnection(params?.connection);
        if (!found.ok) return text(found.message);

        const statement = String(params?.sql ?? "").trim();
        if (!statement) return text("error: sql required");

        // Only run_query resolves the encrypted configuration — it is the only
        // one of the three tools that needs the password in memory.
        const resolved = await resolveConfig(found.row);
        if (!resolved.ok) return text(resolved.message);

        // No clamping here: the registered adapter is the single authority on
        // what a caller-supplied limit means. `??` substitutes the default only
        // when `limit` is absent; unlike `||`, it preserves an explicit zero.
        const cap = Number(params?.limit ?? DATABASE_ROW_CAP);
        const outcome = await execute(resolved.config, statement, cap);
        const safe = outcome.ok
          ? outcome
          : { ok: false as const, error: redactDatabaseError(outcome.error, resolved.config) };
        return text(renderOutcome(safe));
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

function renderQueryError(error: DatabaseError): string {
  if (error.code === "timeout") {
    return (
      `${error.message} — this query was cancelled for taking too long. Re-running it unchanged ` +
      "will time out again. Aggregate in SQL (COUNT/SUM/GROUP BY), add a WHERE filter to " +
      "narrow it, or select fewer rows instead."
    );
  }
  return error.message;
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
 *
 * `rowCount` is the number of rows actually rendered (`outcome.rows.length`),
 * never the caller's requested `limit` — the driver's `boundCap` is free to
 * clamp the request down (or a byte cap can cut it shorter still), so only
 * the rendered count is guaranteed true of what the model is looking at.
 */
function truncationNote(reason: "rows" | "bytes" | null | undefined, rowCount: number): string {
  if (reason === "bytes") {
    return (
      `(truncated: this result exceeds the ${DATABASE_BYTE_CAP.toLocaleString("en-US")}-byte budget. ` +
      "Select fewer columns, or wrap a wide column with left(col, n), rather than re-running as-is.)"
    );
  }
  return `(showing the first ${rowCount} rows — more exist. Aggregate in SQL rather than paginating.)`;
}

function renderOutcome(outcome: QueryOutcome): string {
  if (!outcome.ok) return `query failed [${outcome.error.code}]: ${renderQueryError(outcome.error)}`;
  if (!outcome.rows.length) {
    return outcome.truncated
      ? `no rows returned\n\n${truncationNote(outcome.truncatedReason, 0)}`
      : "no rows";
  }

  const header = outcome.columns.join(" | ");
  const body = outcome.rows
    .map((r) => outcome.columns.map((c) => format(r[c])).join(" | "))
    .join("\n");
  const note = outcome.truncated
    ? `\n\n${truncationNote(outcome.truncatedReason, outcome.rows.length)}`
    : "";

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
