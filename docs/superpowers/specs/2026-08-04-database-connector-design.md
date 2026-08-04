# Read-only database connector — design

Date: 2026-08-04

## Problem

The context layer holds one kind of context: PDFs a user uploaded. Most of what
an organisation knows sits in a database, and the agent cannot reach it.

Adding it is not the same problem as adding documents. A PDF is inert text; a
database is a live system with credentials, write capability, and enough rows to
exhaust a context window on a single careless query. Three things have to be
true before the agent gets near one:

1. **It must know the shape of the data.** A model asked for "refunds last month"
   with no schema invents `refunds.amount` and `refunds.created` and the query
   errors. Correct SQL needs exact column names, types, and the foreign-key graph.
2. **It must not be able to write.** Not by policy — by construction.
3. **A result must not be able to flood the context.** `SELECT * FROM orders` on
   a real table is a runaway.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Engine | PostgreSQL only | `Bun.sql` is built into Bun 1.3, so no new dependency. Postgres has the richest catalog (comments, FK graph, row estimates) and real `READ ONLY` transactions. |
| Driver | `Bun.sql` | Already present. A `DatabaseDriver` interface is *not* introduced — one implementation does not justify an abstraction. |
| Connections | Per-user, added in the UI | Chosen for flexibility over an env-declared catalog. Cost is recorded under Known limitations. |
| Credential storage | AES-256-GCM, key from `CONNECTION_SECRET` | Protects `app.db` at rest. Does not protect the API. |
| Credential exposure | Model never sees a connection string | Tools take a connection *name*; the repository resolves it server-side. |
| Snapshot | Structured tables in `app.db` | `search_schema` must rank columns independently of tables, and the FK columns are what make joins correct. A JSON blob gives neither. |
| Sample rows | None | `describe_table` returns structure only. Real customer data should not enter a model context — or the transcript — as a side effect of describing a table. |
| Agent shape | New `db-analyst` harness, `driver: "pi"` | Appears in the existing harness × model matrix, so a SQL-tuned prompt can be compared against the generic one across models. |
| Tool gating | DB tools only when the harness asks for them | Keeps the general pi agent's tool list and system prompt unchanged. |

## Architecture

The agent runs unchanged. Only three new tools and one new system-prompt block.

```
apps/api/src
  lib/crypto.ts                          AES-256-GCM encrypt/decrypt
  models/schema.ts                       + db_connections, db_tables, db_columns
                                           + db_schema_fts (virtual, in ensureSchema)
  repositories/
    database-connection.repository.ts    the only thing touching those four tables
  services/db/
    postgres.driver.ts                   Bun.sql: connect, introspect, readOnlyQuery
    introspect.service.ts                catalog queries -> snapshot
    sql-guard.ts                         pure statement allowlist (no I/O)
  services/db-tools.ts                   createDatabaseTools(userId)
  controllers/database.controller.ts     HTTP in/out only
  routes/database.routes.ts              URL -> controller
  catalog/harnesses.ts                   + db-analyst, + optional `tools` gate
  services/pi.service.ts                 gate tool injection + inventory prompt
```

`sql-guard.ts` and `crypto.ts` are pure and dependency-free. That is deliberate:
they carry most of the risk and all of it is unit-testable without a database.

### Data model

```
db_connections  id, userId, name, engine, secret (encrypted URL),
                displayHost, displayDatabase,      -- for the UI, never the password
                status: connected | error, error, tableCount,
                lastIntrospectedAt, createdAt

db_tables       id, connectionId, userId, schemaName, name, comment,
                rowEstimate, columnCount, indexes (JSON)

db_columns      id, tableId, connectionId, userId, seq, name, dataType,
                nullable, isPrimaryKey, fkTable, fkColumn, comment

db_schema_fts   FTS5 mirror of table/column names + comments, for search_schema
```

`db_schema_fts` follows the `chunks_fts` precedent: a virtual table Drizzle
cannot express, created in `ensureSchema`, written in the same transaction as the
rows it mirrors so the index cannot drift. Everything is scoped by `userId` on
the same axis as `documents`, `conversations`, and `sandboxes`.

### Tools

| Tool | Returns |
| --- | --- |
| `search_schema(query, connection?)` | Ranked tables and columns matching a keyword — the entry point on a wide schema |
| `describe_table(connection, table)` | Columns, types, nullability, PK/FK, indexes, comments, row estimate |
| `run_query(connection, sql, limit?)` | Rows, capped, with truncation reported |

Indexes are stored as JSON on `db_tables` rather than as their own table: they
are only ever read back whole, as a hint that a filter is cheap, and nothing
searches or joins them.

`limit` on `run_query` can only *lower* the 100-row cap, never raise it. An
agent that asks for 5000 rows gets 100 and a truncation notice.

The system prompt carries only the cheap inventory — connection names and table
names — assembled the way `docsPrompt` is today in `pi.service.ts`. Unlike
`docsPrompt`, it is never omitted: when the user has no connection it is replaced
with an explicit "No databases are connected yet" line rather than dropped.
`docsPrompt` can afford to disappear because `search_docs` is only ever offered
alongside it — no documents, no tool, nothing to explain. A `db-analyst` run holds
all three database tools unconditionally (that's the point of gating by harness,
not by corpus), so silence would leave the agent guessing whether the empty
result from `search_schema` means "no databases" or "nothing matched" — the
explicit line answers that up front. Full detail is pulled on demand, so the
design scales from ten tables to a thousand without changing.

This tiering is what makes generated SQL correct rather than merely plausible.
`search_schema("refund")` finds `order_refunds`; `describe_table` returns its
exact columns, types, and the foreign key to `orders.id`; the agent joins on a
real relationship instead of on names that look similar. When it still gets it
wrong, the Postgres error returns as a tool result and the pi loop retries.

### Read-only enforcement

Four layers, weakest to strongest:

1. **Operator.** Documentation directs the connection at a `GRANT SELECT`-only
   role. Not enforceable here, and the layer that matters most in production.
2. **`sql-guard.ts`.** Single statement; must begin `SELECT`, `WITH`, or
   `EXPLAIN`; rejects write keywords **anywhere in the statement**, not only at
   the start. `EXPLAIN ANALYZE` is rejected specifically — it executes the query
   it is asked to explain, so it is a write in every sense that matters.
3. **`BEGIN TRANSACTION READ ONLY`**, always rolled back.
4. **Budget.** `SET LOCAL statement_timeout = '10s'` inside that transaction,
   plus a 100-row / 50KB result cap.

Layer 2 exists to give the agent a good error message. **Layer 3 is the actual
guarantee**, and the distinction is load-bearing: Postgres permits data-modifying
CTEs, so

```sql
WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x
```

begins with `WITH` and writes. A prefix check passes it. The keyword scan rejects
it, and the read-only transaction rejects it even if the scan is ever wrong.

### Data flow

```
POST /api/databases  ->  encrypt URL  ->  connect  ->  introspect
                                                          |
                             db_tables + db_columns + db_schema_fts
                                                          |
run with harness=db-analyst  ->  inventory in system prompt
                             ->  search_schema / describe_table / run_query
```

Introspection runs when a connection is added and on explicit refresh. It is not
re-run per agent turn: a snapshot makes runs fast and deterministic, and a stale
column surfaces as a SQL error the agent can recover from, which is a better
failure than a round trip on every call.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/databases?userId=` | List connections (secret redacted) |
| POST | `/api/databases` | Add a connection, then introspect |
| POST | `/api/databases/:id/refresh` | Re-introspect |
| DELETE | `/api/databases/:id` | Remove a connection and its snapshot |

### Console

One panel beside the existing document upload: add a connection, see its status
and table count, refresh, remove. It reuses the states the document list already
renders — a connection that failed to introspect shows its reason the way a PDF
that failed to index does. A full connection manager is not in scope.

## Error handling

Failures are recorded, not dropped — the principle `ingestPdf` already follows,
where a PDF that cannot be parsed still gets a row so a failed upload is
distinguishable from one that never arrived.

- Unreachable database on add → stored with `status: error` and the reason, shown
  in the UI rather than discarded.
- Partial introspection (no permission on some schemas) → stored, with a note.
- SQL error → returned as tool text, **not thrown**, so the loop retries with the
  real Postgres message.
- Timeout → a distinct message telling the agent to aggregate rather than re-run
  the same query.
- Truncation → `showing the first 100 rows — more exist`, so the agent aggregates
  instead of paginating. The total is deliberately not reported: knowing it would
  cost a second `COUNT(*)` over the same query.
- `CONNECTION_SECRET` missing → refuse to store a connection, loudly. No
  plaintext fallback, for the same reason the sandbox refuses to fall back to the
  host when Docker is down.
- Connection name unknown to a tool → list the valid names back to the agent.

## Testing

| Test | Kind |
| --- | --- |
| `sql-guard.test.ts` | Pure. Allows `SELECT`/`WITH`/`EXPLAIN`; rejects multi-statement, data-modifying CTE, and comment-obfuscated writes (`SELECT 1; /**/DROP TABLE t`) |
| `crypto.test.ts` | Roundtrip; decryption under the wrong key fails |
| `introspect.service.test.ts` | Pure. `buildSnapshot` merges flat catalog rows (tables, columns, PKs, FKs, indexes) into the snapshot; fixture rows in, snapshot out, no driver involved |
| `database-connection.repository.test.ts` | Real SQLite, matching the existing repository tests |
| `scripts/db-connector-check.ts` | Manual, needs a real Postgres: proves a write is refused at the transaction layer with the guard disabled |

The last one matters because it tests layer 3 in isolation. With the guard
enabled, a passing test proves nothing about which layer did the work.

## Known limitations

Connection strings are stored against a `userId` the browser generates and keeps
in localStorage. There is no authentication, so anyone who forges a `userId` can
use that user's connections. Encryption protects `app.db` at rest; it does not
protect the API.

This is accepted for the POC and bounded by two things: the connection should
point at a read-only role, and the model never receives the connection string, so
a prompt-injected document cannot exfiltrate a credential it was never given.
Real authentication is the prerequisite before this touches production data — the
same prerequisite that blocks the Google Workspace and Microsoft 365 connectors.

## Out of scope

- MySQL, SQLite, and any `DatabaseDriver` abstraction. One engine, one
  implementation; the interface can be extracted when there is a second.
- MCP. Wrapping these tools as an MCP server, or consuming a third-party database
  MCP server, is a separate piece of work.
- Sample rows and column statistics in `describe_table`.
- Writes of any kind, including temp tables and `EXPLAIN ANALYZE` (which executes
  the query).
- Query result caching, saved queries, and charting.
