# Read-Only Database Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent read-only access to a user's PostgreSQL databases, with a stored schema snapshot as its context layer, exposed through a specialised `db-analyst` harness on the existing pi runtime.

**Architecture:** A user adds a Postgres URL in the console. It is encrypted, stored, and introspected once into structured snapshot tables in `app.db` (`db_tables`, `db_columns`, plus an FTS5 mirror). When the `db-analyst` harness runs, three tools are injected — `search_schema`, `describe_table`, `run_query` — and a cheap table-name inventory is appended to the system prompt. Every query passes a pure statement guard and then executes inside a `READ ONLY` transaction that is always rolled back.

**Tech Stack:** Bun 1.3 (`Bun.SQL`, built in — no new dependency), Hono, Drizzle ORM over `bun:sqlite`, `bun:test`, React 19 + Tailwind v4 + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-04-database-connector-design.md`

## Global Constraints

- **PostgreSQL only.** No MySQL, no SQLite targets, no `DatabaseDriver` interface. One engine, one implementation.
- **No new dependencies.** `Bun.SQL` and `node:crypto` cover everything. Do not add `pg`, `postgres`, or a SQL parser.
- **The model never receives a connection string.** Tools accept a connection *name*; the repository resolves name → decrypted URL server-side. No tool return value, log line, or error message may contain the secret.
- **`describe_table` returns structure only.** Never sample rows, never column value statistics.
- **Row cap is 100, statement timeout is 10s.** A caller-supplied `limit` may only lower the cap, never raise it.
- **Layering is fixed:** route → controller → service → repository. Only the repository touches the database.
- **Failures are recorded, not dropped** — the precedent `ingestPdf` sets by keeping a row for a PDF it could not parse.
- **Every new file gets a header comment explaining *why* it exists**, matching the density of the surrounding code (see `context-tools.ts`, `search.service.ts`).
- Type-check with `bunx tsc --noEmit` in `apps/api` before every commit.

---

### Task 1: Encrypted credential storage

**Files:**
- Create: `apps/api/src/lib/crypto.ts`
- Create: `apps/api/src/lib/crypto.test.ts`
- Modify: `apps/api/src/config/env.ts` (add `connectionSecret`)
- Modify: `apps/api/.env.example`

**Interfaces:**
- Consumes: `env` from `../config/env`
- Produces: `encryptSecret(plaintext: string): string`, `decryptSecret(payload: string): string`. Payload format is `v1.<ivB64>.<tagB64>.<cipherB64>`. Both throw `Error` when `CONNECTION_SECRET` is unset.

- [ ] **Step 1: Add the env var**

In `apps/api/src/config/env.ts`, add to the `env` object:

```ts
  /**
   * Key material for encrypting stored database connection strings. Absent, the
   * API refuses to store one rather than writing it in plaintext — the same
   * stance the sandbox takes when Docker is down.
   */
  connectionSecret: process.env.CONNECTION_SECRET ?? "",
```

Append to `apps/api/.env.example`:

```bash
# Required before a database connection can be stored. Any long random string.
# Generate one with: openssl rand -base64 32
CONNECTION_SECRET=
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/lib/crypto.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { env } from "../config/env";
import { decryptSecret, encryptSecret } from "./crypto";

const original = env.connectionSecret;
const setSecret = (v: string) => {
  (env as { connectionSecret: string }).connectionSecret = v;
};

afterEach(() => setSecret(original));

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a connection string", () => {
    setSecret("test-secret-one");
    const url = "postgres://reader:hunter2@db.example.com:5432/sales";
    expect(decryptSecret(encryptSecret(url))).toBe(url);
  });

  it("produces different ciphertext for the same plaintext", () => {
    setSecret("test-secret-one");
    expect(encryptSecret("postgres://a@b/c")).not.toBe(encryptSecret("postgres://a@b/c"));
  });

  it("fails to decrypt under a different key", () => {
    setSecret("test-secret-one");
    const payload = encryptSecret("postgres://a@b/c");
    setSecret("test-secret-two");
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    setSecret("test-secret-one");
    const parts = encryptSecret("postgres://a@b/c").split(".");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("refuses to encrypt with no secret configured", () => {
    setSecret("");
    expect(() => encryptSecret("postgres://a@b/c")).toThrow(/CONNECTION_SECRET/);
  });

  it("rejects a malformed payload", () => {
    setSecret("test-secret-one");
    expect(() => decryptSecret("not-a-payload")).toThrow(/malformed/);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd apps/api && bun test src/lib/crypto.test.ts`
Expected: FAIL — cannot resolve module `./crypto`.

- [ ] **Step 4: Implement**

Create `apps/api/src/lib/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../config/env";

/**
 * Authenticated encryption for stored database credentials.
 *
 * AES-256-GCM rather than a plain cipher because a tampered ciphertext must fail
 * loudly: a connection string that silently decrypts to garbage would be handed
 * to a Postgres driver as a hostname.
 *
 * This protects `app.db` at rest. It does not protect the API — see the Known
 * limitations section of the connector design.
 */

const SALT = "salurai.connection.v1";

// scrypt takes ~100ms, and a key is derived on every tool call. Cached by the
// secret itself rather than once, so tests that swap the env var still work.
const derived = new Map<string, Buffer>();

function key(): Buffer {
  const secret = env.connectionSecret;
  if (!secret) {
    throw new Error(
      "CONNECTION_SECRET is not set — refusing to store or read a database credential",
    );
  }
  let k = derived.get(secret);
  if (!k) {
    k = scryptSync(secret, SALT, 32);
    derived.set(secret, k);
  }
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, bodyB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !bodyB64) {
    throw new Error("malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bun test src/lib/crypto.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Type-check and commit**

```bash
cd apps/api && bunx tsc --noEmit
git add apps/api/src/lib/crypto.ts apps/api/src/lib/crypto.test.ts \
        apps/api/src/config/env.ts apps/api/.env.example
git commit -m "feat: authenticated encryption for stored database credentials"
```

---

### Task 2: The read-only SQL guard

**Files:**
- Create: `apps/api/src/services/db/sql-guard.ts`
- Create: `apps/api/src/services/db/sql-guard.test.ts`

**Interfaces:**
- Consumes: nothing. Pure, no imports.
- Produces: `type GuardResult = { ok: true; sql: string } | { ok: false; reason: string }` and `guardReadOnly(raw: string): GuardResult`. On success `sql` is the original statement with any trailing semicolon removed — comments and string literals intact, because only the *analysis* copy is stripped.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/db/sql-guard.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { guardReadOnly } from "./sql-guard";

const ALLOWED = [
  ["a bare select", "SELECT 1"],
  ["a lowercase select", "select count(*) from orders"],
  ["a trailing semicolon", "SELECT 1;"],
  ["a CTE", "WITH recent AS (SELECT * FROM orders LIMIT 10) SELECT count(*) FROM recent"],
  ["EXPLAIN without ANALYZE", "EXPLAIN SELECT * FROM orders"],
  ["a write keyword inside a string literal", "SELECT * FROM orders WHERE status = 'deleted'"],
  ["an escaped quote in a literal", "SELECT * FROM t WHERE note = 'it''s deleted'"],
  ["OFFSET, which contains SET", "SELECT * FROM orders OFFSET 10"],
  ["a column whose name contains a keyword", "SELECT updated_at, created_at FROM orders"],
  ["a column literally named close", "SELECT open, high, low, close FROM prices"],
  ["a column literally named comment", "SELECT comment FROM reviews"],
  ["a column named start", "SELECT start, duration FROM sessions"],
  ["leading whitespace and newlines", "\n\n  SELECT 1\n"],
] as const;

const REJECTED = [
  ["a delete", "DELETE FROM orders"],
  ["an update", "UPDATE orders SET total = 0"],
  ["an insert", "INSERT INTO orders (id) VALUES (1)"],
  ["a stacked statement", "SELECT 1; DROP TABLE orders"],
  ["a stacked statement hidden behind a block comment", "SELECT 1; /**/DROP TABLE orders"],
  ["a write hidden behind a line comment", "SELECT 1 --\nDROP TABLE orders"],
  ["a data-modifying CTE", "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x"],
  ["EXPLAIN ANALYZE, which executes", "EXPLAIN ANALYZE SELECT * FROM orders"],
  ["a temp table", "CREATE TEMP TABLE t AS SELECT 1"],
  ["a session variable change", "SET statement_timeout = 0"],
  ["a transaction control statement", "COMMIT"],
  ["COMMENT ON, caught by the prefix check", "COMMENT ON TABLE orders IS 'x'"],
  ["a cursor declaration, caught by the prefix check", "DECLARE c CURSOR FOR SELECT 1"],
  ["an empty statement", "   "],
  ["a bare non-select", "TRUNCATE orders"],
] as const;

describe("guardReadOnly", () => {
  for (const [label, sql] of ALLOWED) {
    it(`allows ${label}`, () => {
      const out = guardReadOnly(sql);
      expect(out.ok).toBe(true);
    });
  }

  for (const [label, sql] of REJECTED) {
    it(`rejects ${label}`, () => {
      const out = guardReadOnly(sql);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason.length).toBeGreaterThan(0);
    });
  }

  it("returns the statement with the trailing semicolon removed", () => {
    const out = guardReadOnly("SELECT 1;");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sql).toBe("SELECT 1");
  });

  it("preserves string literals in the returned statement", () => {
    const sql = "SELECT * FROM orders WHERE status = 'deleted'";
    const out = guardReadOnly(sql);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sql).toBe(sql);
  });

  it("names the offending keyword so the agent can correct itself", () => {
    const out = guardReadOnly("DELETE FROM orders");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason.toLowerCase()).toContain("delete");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && bun test src/services/db/sql-guard.test.ts`
Expected: FAIL — cannot resolve module `./sql-guard`.

- [ ] **Step 3: Implement**

> **Superseded — do not copy this code block.** Review found a critical defect in
> it: the single-quote scanner desyncs on Postgres `E'...'` escape strings, so
> `SELECT E'\'' ; SET statement_timeout = 1 --'` passed as safe with a stacked
> `SET` intact — and `SET` is *not* blocked by the `READ ONLY` transaction behind
> the guard. Fixed in commit `6fd0664`, which also makes unterminated literals
> fail closed. Read the shipped `sql-guard.ts`, not this listing.

Create `apps/api/src/services/db/sql-guard.ts`:

```ts
/**
 * Statement-level allowlist for anything the agent wants to run.
 *
 * This is layer 2 of four. It exists to give the model a good error message it
 * can correct itself from — the actual guarantee is the `READ ONLY` transaction
 * in the driver, which holds even if everything here is wrong.
 *
 * Two details are load-bearing:
 *
 * - String literals and comments are stripped *before* scanning. Without that,
 *   `WHERE status = 'deleted'` is rejected and a `--` comment can hide a stacked
 *   statement.
 * - Write keywords are searched for anywhere in the statement, not just at the
 *   start. Postgres allows data-modifying CTEs, so
 *   `WITH x AS (DELETE ... RETURNING *) SELECT * FROM x` begins with `WITH` and
 *   writes.
 */

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * Words that can write from *inside* a statement — within a CTE, a subquery, or
 * after a stacked semicolon the multi-statement check somehow let through.
 *
 * Deliberately narrow. Words that can only ever begin a statement (COMMENT,
 * CLOSE, FETCH, DECLARE, EXECUTE, PREPARE, CALL, DO, RELEASE, START, MOVE) are
 * already blocked by the SELECT/WITH/EXPLAIN prefix check, and several of them
 * are common column names — a price table has a `close`, a review table has a
 * `comment`. Listing them here would reject ordinary reads, and the READ ONLY
 * transaction catches anything this scan misses regardless.
 */
const FORBIDDEN = [
  "insert", "update", "delete", "truncate", "drop", "alter", "create", "grant",
  "revoke", "merge", "copy", "vacuum", "reindex", "refresh", "cluster", "lock",
  "set", "reset", "commit", "rollback", "savepoint", "discard",
];

/**
 * Replace comments and string literals with equivalent-length blanks. Blanking
 * rather than deleting keeps offsets stable, so a future caller could report a
 * position without re-parsing.
 */
function blankLiteralsAndComments(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== "\n") out[j] = " ";
    }
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === "/*") {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") { depth++; j += 2; continue; }
        if (sql.slice(j, j + 2) === "*/") { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } // '' escape
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === '"') {
      // Quoted identifier: not a literal, but its contents must not be scanned
      // for keywords either — a column may legitimately be named "update".
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      blank(i, j + 1);
      i = j + 1;
      continue;
    }

    if (sql[i] === "$") {
      // Dollar-quoted string: $tag$ ... $tag$
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i++;
  }

  return out.join("");
}

export function guardReadOnly(raw: string): GuardResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty statement" };

  const scan = blankLiteralsAndComments(trimmed).trim();

  // One statement only. A trailing semicolon is fine; anything after it is not.
  const withoutTrailing = scan.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return {
      ok: false,
      reason: "only one statement may be run at a time — remove the extra ';'",
    };
  }

  if (!/^(select|with|explain)\b/i.test(withoutTrailing)) {
    const first = withoutTrailing.split(/\s+/)[0] ?? "";
    return {
      ok: false,
      reason: `only SELECT, WITH, and EXPLAIN are permitted — this starts with "${first}"`,
    };
  }

  if (/^explain\b/i.test(withoutTrailing) && /\banalyze\b/i.test(withoutTrailing)) {
    return {
      ok: false,
      reason: "EXPLAIN ANALYZE executes the query it explains — use plain EXPLAIN",
    };
  }

  // EXPLAIN's own body is scanned by the keyword pass below, so `EXPLAIN DELETE`
  // is caught there rather than needing a case here.
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, "i").test(withoutTrailing)) {
      return {
        ok: false,
        reason: `this connection is read-only — "${word.toUpperCase()}" is not permitted`,
      };
    }
  }

  return { ok: true, sql: trimmed.replace(/;\s*$/, "") };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bun test src/services/db/sql-guard.test.ts`
Expected: PASS, 31 tests.

If an `allows` case fails, the `FORBIDDEN` word that tripped it is over-broad — remove it from the list rather than special-casing the test. The list is intentionally narrow, and the `READ ONLY` transaction is what makes that safe.

- [ ] **Step 5: Type-check and commit**

```bash
cd apps/api && bunx tsc --noEmit
git add apps/api/src/services/db/sql-guard.ts apps/api/src/services/db/sql-guard.test.ts
git commit -m "feat: read-only SQL statement guard"
```

---

### Task 3: Connection tables and the repository

**Files:**
- Modify: `apps/api/src/models/schema.ts` (append three tables + row types)
- Modify: `apps/api/src/db/client.ts` (exports + `applySchema` DDL + FTS table)
- Create: `apps/api/src/repositories/database-connection.repository.ts`
- Create: `apps/api/src/repositories/database-connection.repository.test.ts`

**Interfaces:**
- Consumes: `encryptSecret` / `decryptSecret` from `../lib/crypto`
- Produces:

```ts
export type NewConnection = {
  id: string; userId: string; name: string; url: string;
  displayHost: string; displayDatabase: string;
};
export type ConnectionInventoryEntry = { name: string; tableCount: number; tables: string[] };
export type SchemaHit = {
  connectionName: string; schemaName: string; tableName: string;
  columnName: string | null; kind: "table" | "column"; detail: string; score: number;
};
export type TableDetail = {
  connectionName: string; schemaName: string; name: string;
  comment: string | null; rowEstimate: number; indexes: string[];
  columns: DbColumnRow[];
};
export interface DatabaseConnectionStore {
  create(conn: NewConnection): Promise<void>;
  list(userId: string): Promise<DbConnectionRow[]>;          // never includes `secret`
  findByName(userId: string, name: string): Promise<DbConnectionRow | null>;
  resolveUrl(userId: string, connectionId: string): Promise<string | null>;
  markStatus(id: string, status: DbConnectionStatus, error: string | null): Promise<void>;
  remove(userId: string, id: string): Promise<boolean>;
}
export class SqliteDatabaseConnectionStore implements DatabaseConnectionStore { … }
export const databaseConnectionStore: DatabaseConnectionStore;
```

Snapshot writes and reads are added to this same store in Task 5.

- [ ] **Step 1: Add the Drizzle tables**

Append to `apps/api/src/models/schema.ts`:

```ts
// ---- context layer: connected databases and their schema snapshot ----

/** Whether the last introspection of a connection succeeded. */
export type DbConnectionStatus = "connected" | "error";

/**
 * One database a user has connected. `secret` holds the encrypted connection
 * string and is never selected into anything that reaches the client or the
 * model — `displayHost` / `displayDatabase` exist so the UI can identify a
 * connection without it.
 */
export const dbConnections = sqliteTable(
  "db_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(), // how the agent refers to it
    engine: text("engine").notNull().default("postgres"),
    secret: text("secret").notNull(),
    displayHost: text("display_host").notNull(),
    displayDatabase: text("display_database").notNull(),
    status: text("status").$type<DbConnectionStatus>().notNull().default("connected"),
    error: text("error"),
    tableCount: integer("table_count").notNull().default(0),
    lastIntrospectedAt: integer("last_introspected_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_db_connections_user").on(t.userId, t.createdAt)],
);
export type DbConnectionRow = {
  id: string;
  userId: string;
  name: string;
  engine: string;
  status: DbConnectionStatus;
  error: string | null;
  displayHost: string;
  displayDatabase: string;
  tableCount: number;
  lastIntrospectedAt: number | null;
  createdAt: number;
};

/** One table (or view) in a connection's snapshot. */
export const dbTables = sqliteTable(
  "db_tables",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => dbConnections.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    schemaName: text("schema_name").notNull(),
    name: text("name").notNull(),
    comment: text("comment"),
    rowEstimate: integer("row_estimate").notNull().default(0),
    columnCount: integer("column_count").notNull().default(0),
    // JSON array of index definitions. Stored whole rather than in its own table
    // because nothing searches or joins them — they are read back as a hint that
    // a filter is cheap.
    indexes: text("indexes"),
  },
  (t) => [index("idx_db_tables_connection").on(t.connectionId, t.schemaName, t.name)],
);
export type DbTableRow = {
  id: string;
  connectionId: string;
  userId: string;
  schemaName: string;
  name: string;
  comment: string | null;
  rowEstimate: number;
  columnCount: number;
  indexes: string | null;
};

/** One column, with the foreign key that makes a correct join possible. */
export const dbColumns = sqliteTable(
  "db_columns",
  {
    id: text("id").primaryKey(),
    tableId: text("table_id")
      .notNull()
      .references(() => dbTables.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    userId: text("user_id").notNull(),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    dataType: text("data_type").notNull(),
    nullable: integer("nullable").notNull(), // 0 | 1
    isPrimaryKey: integer("is_primary_key").notNull(), // 0 | 1
    fkTable: text("fk_table"), // "schema.table"
    fkColumn: text("fk_column"),
    comment: text("comment"),
  },
  (t) => [index("idx_db_columns_table").on(t.tableId, t.seq)],
);
export type DbColumnRow = {
  id: string;
  tableId: string;
  connectionId: string;
  userId: string;
  seq: number;
  name: string;
  dataType: string;
  nullable: number;
  isPrimaryKey: number;
  fkTable: string | null;
  fkColumn: string | null;
  comment: string | null;
};
```

- [ ] **Step 2: Add the DDL and the FTS mirror**

In `apps/api/src/db/client.ts`, extend the import from `../models/schema` and the re-export with `dbConnections, dbTables, dbColumns`, and the type re-export with `DbConnectionRow, DbConnectionStatus, DbTableRow, DbColumnRow`.

Append inside the first `target.exec(...)` template in `applySchema`:

```sql
    CREATE TABLE IF NOT EXISTS db_connections (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      name                 TEXT NOT NULL,
      engine               TEXT NOT NULL DEFAULT 'postgres',
      secret               TEXT NOT NULL,
      display_host         TEXT NOT NULL,
      display_database     TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'connected',
      error                TEXT,
      table_count          INTEGER NOT NULL DEFAULT 0,
      last_introspected_at INTEGER,
      created_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_db_connections_user ON db_connections (user_id, created_at);
    -- The agent addresses a connection by name, so a duplicate name would make
    -- "query the sales database" ambiguous. Rejected at the schema level.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_db_connections_name ON db_connections (user_id, name);
    CREATE TABLE IF NOT EXISTS db_tables (
      id            TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL,
      schema_name   TEXT NOT NULL,
      name          TEXT NOT NULL,
      comment       TEXT,
      row_estimate  INTEGER NOT NULL DEFAULT 0,
      column_count  INTEGER NOT NULL DEFAULT 0,
      indexes       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_db_tables_connection ON db_tables (connection_id, schema_name, name);
    CREATE TABLE IF NOT EXISTS db_columns (
      id             TEXT PRIMARY KEY,
      table_id       TEXT NOT NULL REFERENCES db_tables(id) ON DELETE CASCADE,
      connection_id  TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      name           TEXT NOT NULL,
      data_type      TEXT NOT NULL,
      nullable       INTEGER NOT NULL,
      is_primary_key INTEGER NOT NULL,
      fk_table       TEXT,
      fk_column      TEXT,
      comment        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_db_columns_table ON db_columns (table_id, seq);
```

Append a second virtual-table `exec` after the existing `chunks_fts` one:

```ts
  // Schema search. Same `porter` reasoning as chunks_fts: a search for "refund"
  // should reach a table called `refunds`.
  target.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS db_schema_fts USING fts5(
      text,
      object_id     UNINDEXED,
      connection_id UNINDEXED,
      kind          UNINDEXED,
      tokenize = 'porter'
    );
  `);
```

- [ ] **Step 3: Write the failing test**

Create `apps/api/src/repositories/database-connection.repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteDatabaseConnectionStore } from "./database-connection.repository";

(env as { connectionSecret: string }).connectionSecret = "test-secret";

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteDatabaseConnectionStore(drizzle(sqlite) as any);
}

const conn = (over: Partial<Parameters<SqliteDatabaseConnectionStore["create"]>[0]> = {}) => ({
  id: "c1",
  userId: "u1",
  name: "sales",
  url: "postgres://reader:hunter2@db.example.com:5432/sales",
  displayHost: "db.example.com",
  displayDatabase: "sales",
  ...over,
});

let store: SqliteDatabaseConnectionStore;
beforeEach(() => {
  store = freshStore();
});

describe("SqliteDatabaseConnectionStore", () => {
  it("stores a connection and lists it back without the secret", async () => {
    await store.create(conn());
    const rows = await store.list("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("sales");
    expect(rows[0]!.displayHost).toBe("db.example.com");
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
  });

  it("does not store the connection string in plaintext", async () => {
    await store.create(conn());
    const raw = await store.debugRawSecret("c1");
    expect(raw).not.toContain("hunter2");
    expect(raw?.startsWith("v1.")).toBe(true);
  });

  it("resolves the decrypted url for its owner", async () => {
    await store.create(conn());
    expect(await store.resolveUrl("u1", "c1")).toContain("hunter2");
  });

  it("refuses to resolve a url for a different user", async () => {
    await store.create(conn());
    expect(await store.resolveUrl("someone-else", "c1")).toBeNull();
  });

  it("scopes listing by user", async () => {
    await store.create(conn());
    await store.create(conn({ id: "c2", userId: "u2", name: "other" }));
    expect(await store.list("u1")).toHaveLength(1);
  });

  it("finds a connection by name", async () => {
    await store.create(conn());
    expect((await store.findByName("u1", "sales"))?.id).toBe("c1");
    expect(await store.findByName("u1", "nope")).toBeNull();
  });

  it("rejects a duplicate name for the same user", async () => {
    await store.create(conn());
    await expect(store.create(conn({ id: "c9" }))).rejects.toThrow();
  });

  it("allows the same name for different users", async () => {
    await store.create(conn());
    await store.create(conn({ id: "c2", userId: "u2" }));
    expect(await store.list("u2")).toHaveLength(1);
  });

  it("records an introspection failure without discarding the connection", async () => {
    await store.create(conn());
    await store.markStatus("c1", "error", "could not connect: timeout");
    const row = (await store.list("u1"))[0]!;
    expect(row.status).toBe("error");
    expect(row.error).toBe("could not connect: timeout");
  });

  it("removes only the caller's connection", async () => {
    await store.create(conn());
    expect(await store.remove("someone-else", "c1")).toBe(false);
    expect(await store.remove("u1", "c1")).toBe(true);
    expect(await store.list("u1")).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `cd apps/api && bun test src/repositories/database-connection.repository.test.ts`
Expected: FAIL — cannot resolve module `./database-connection.repository`.

- [ ] **Step 5: Implement the repository**

Create `apps/api/src/repositories/database-connection.repository.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { db, dbConnections } from "../db/client";
import type { DbConnectionRow, DbConnectionStatus } from "../models/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

/**
 * The only thing that touches `db_connections`, `db_tables`, `db_columns`, and
 * `db_schema_fts`.
 *
 * `list` deliberately selects columns rather than `select()`: the encrypted
 * secret must never leave this module by accident, and an explicit column list
 * is the only way that stays true when the table gains a field.
 */

export type NewConnection = {
  id: string;
  userId: string;
  name: string;
  url: string;
  displayHost: string;
  displayDatabase: string;
};

export interface DatabaseConnectionStore {
  create(conn: NewConnection): Promise<void>;
  list(userId: string): Promise<DbConnectionRow[]>;
  findByName(userId: string, name: string): Promise<DbConnectionRow | null>;
  resolveUrl(userId: string, connectionId: string): Promise<string | null>;
  markStatus(id: string, status: DbConnectionStatus, error: string | null): Promise<void>;
  remove(userId: string, id: string): Promise<boolean>;
}

const PUBLIC_COLUMNS = {
  id: dbConnections.id,
  userId: dbConnections.userId,
  name: dbConnections.name,
  engine: dbConnections.engine,
  status: dbConnections.status,
  error: dbConnections.error,
  displayHost: dbConnections.displayHost,
  displayDatabase: dbConnections.displayDatabase,
  tableCount: dbConnections.tableCount,
  lastIntrospectedAt: dbConnections.lastIntrospectedAt,
  createdAt: dbConnections.createdAt,
};

export class SqliteDatabaseConnectionStore implements DatabaseConnectionStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(conn: NewConnection): Promise<void> {
    await this.dbImpl.insert(dbConnections).values({
      id: conn.id,
      userId: conn.userId,
      name: conn.name,
      engine: "postgres",
      secret: encryptSecret(conn.url),
      displayHost: conn.displayHost,
      displayDatabase: conn.displayDatabase,
      status: "connected",
      error: null,
      tableCount: 0,
      lastIntrospectedAt: null,
      createdAt: Date.now(),
    });
  }

  async list(userId: string): Promise<DbConnectionRow[]> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(eq(dbConnections.userId, userId))
      .orderBy(sql`created_at desc`);
    return rows as DbConnectionRow[];
  }

  async findByName(userId: string, name: string): Promise<DbConnectionRow | null> {
    const rows = await this.dbImpl
      .select(PUBLIC_COLUMNS)
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.name, name)));
    return (rows[0] as DbConnectionRow) ?? null;
  }

  /** Decrypts only after confirming the caller owns the row. */
  async resolveUrl(userId: string, connectionId: string): Promise<string | null> {
    const rows = await this.dbImpl
      .select({ secret: dbConnections.secret })
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.id, connectionId)));
    const secret = rows[0]?.secret;
    return secret ? decryptSecret(secret) : null;
  }

  async markStatus(
    id: string,
    status: DbConnectionStatus,
    error: string | null,
  ): Promise<void> {
    await this.dbImpl
      .update(dbConnections)
      .set({ status, error })
      .where(eq(dbConnections.id, id));
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const owned = await this.dbImpl
      .select({ id: dbConnections.id })
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.id, id)));
    if (!owned.length) return false;

    this.dbImpl.transaction((tx) => {
      // db_tables and db_columns cascade; the FTS mirror is virtual and has no
      // foreign keys, so it is cleared explicitly — same as chunks_fts.
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id = ${id}`);
      tx.delete(dbConnections).where(eq(dbConnections.id, id)).run();
    });
    return true;
  }

  /** Test-only: proves the stored value is ciphertext, not a URL. */
  async debugRawSecret(id: string): Promise<string | null> {
    const rows = await this.dbImpl
      .select({ secret: dbConnections.secret })
      .from(dbConnections)
      .where(eq(dbConnections.id, id));
    return rows[0]?.secret ?? null;
  }
}

export const databaseConnectionStore = new SqliteDatabaseConnectionStore();
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun test src/repositories/database-connection.repository.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Confirm nothing else broke, then commit**

```bash
cd apps/api && bun test && bunx tsc --noEmit
git add apps/api/src/models/schema.ts apps/api/src/db/client.ts \
        apps/api/src/repositories/database-connection.repository.ts \
        apps/api/src/repositories/database-connection.repository.test.ts
git commit -m "feat: connection and schema-snapshot tables with an encrypted store"
```

---

### Task 4: The Postgres driver

**Files:**
- Create: `apps/api/src/services/db/postgres.driver.ts`

**Interfaces:**
- Consumes: `guardReadOnly` from `./sql-guard`
- Produces:

```ts
export type RawCatalog = {
  tables: { schemaName: string; name: string; comment: string | null; rowEstimate: number }[];
  columns: { schemaName: string; tableName: string; seq: number; name: string;
             dataType: string; nullable: boolean; comment: string | null }[];
  primaryKeys: { schemaName: string; tableName: string; columnName: string }[];
  foreignKeys: { schemaName: string; tableName: string; columnName: string;
                 refSchema: string; refTable: string; refColumn: string }[];
  indexes: { schemaName: string; tableName: string; definition: string }[];
};
export type Probe = { ok: true; host: string; database: string } | { ok: false; error: string };
export type QueryOutcome =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; error: string };

export const ROW_CAP = 100;
export async function probe(url: string): Promise<Probe>;
export async function fetchCatalog(url: string): Promise<RawCatalog>;
export async function runReadOnly(url: string, rawSql: string, cap?: number): Promise<QueryOutcome>;
```

No test file. Every function here requires a live Postgres; the logic that *can* be tested without one lives in `sql-guard.ts` (Task 2) and `buildSnapshot` (Task 5). Task 10 adds the manual check that exercises this file against a real server.

- [ ] **Step 1: Implement the driver**

Create `apps/api/src/services/db/postgres.driver.ts`:

```ts
import { guardReadOnly } from "./sql-guard";

/**
 * Everything that speaks to a user's PostgreSQL server.
 *
 * `Bun.SQL` is used directly rather than behind an interface: there is one
 * engine, and an abstraction with one implementation is a guess about the
 * second. The catalog queries return flat rows and are merged into a snapshot by
 * `buildSnapshot`, which keeps the merge logic pure and testable.
 */

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema')`;
const STATEMENT_TIMEOUT_MS = 10_000;

/** Rows returned to the model in one query. A caller may lower this, never raise it. */
export const ROW_CAP = 100;

export type RawCatalog = {
  tables: { schemaName: string; name: string; comment: string | null; rowEstimate: number }[];
  columns: {
    schemaName: string; tableName: string; seq: number; name: string;
    dataType: string; nullable: boolean; comment: string | null;
  }[];
  primaryKeys: { schemaName: string; tableName: string; columnName: string }[];
  foreignKeys: {
    schemaName: string; tableName: string; columnName: string;
    refSchema: string; refTable: string; refColumn: string;
  }[];
  indexes: { schemaName: string; tableName: string; definition: string }[];
};

export type Probe =
  | { ok: true; host: string; database: string }
  | { ok: false; error: string };

export type QueryOutcome =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; error: string };

/**
 * `max: 1` is load-bearing everywhere below: `runReadOnly` issues BEGIN, the
 * query, and ROLLBACK as separate statements, which are only guaranteed to land
 * on the same backend when the pool holds exactly one connection.
 */
function client(url: string): any {
  return new Bun.SQL({ url, max: 1, idleTimeout: 10, connectionTimeout: 10 });
}

/** Never let a driver error carry the credential into a log or a tool result. */
function scrub(message: string, url: string): string {
  let out = message;
  try {
    const parsed = new URL(url);
    if (parsed.password) out = out.split(parsed.password).join("***");
  } catch {
    // A malformed URL has no password to leak.
  }
  return out;
}

export async function probe(url: string): Promise<Probe> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "not a valid connection URL" };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return { ok: false, error: `only postgres:// URLs are supported, got ${parsed.protocol}//` };
  }

  const sql = client(url);
  try {
    await sql`SELECT 1`;
    return {
      ok: true,
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, "") || "postgres",
    };
  } catch (e: any) {
    return { ok: false, error: scrub(e?.message ?? String(e), url) };
  } finally {
    await sql.close().catch(() => {});
  }
}

export async function fetchCatalog(url: string): Promise<RawCatalog> {
  const sql = client(url);
  try {
    const tables = await sql.unsafe(`
      SELECT n.nspname AS "schemaName",
             c.relname AS "name",
             obj_description(c.oid) AS "comment",
             GREATEST(c.reltuples, 0)::bigint AS "rowEstimate"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname, c.relname
    `);

    const columns = await sql.unsafe(`
      SELECT n.nspname AS "schemaName",
             c.relname AS "tableName",
             a.attnum   AS "seq",
             a.attname  AS "name",
             format_type(a.atttypid, a.atttypmod) AS "dataType",
             NOT a.attnotnull AS "nullable",
             col_description(c.oid, a.attnum) AS "comment"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    const primaryKeys = await sql.unsafe(`
      SELECT n.nspname AS "schemaName",
             c.relname AS "tableName",
             a.attname AS "columnName"
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(k.conkey) AS ck(attnum) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
      WHERE k.contype = 'p' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    `);

    const foreignKeys = await sql.unsafe(`
      SELECT n.nspname   AS "schemaName",
             c.relname   AS "tableName",
             a.attname   AS "columnName",
             fn.nspname  AS "refSchema",
             fc.relname  AS "refTable",
             fa.attname  AS "refColumn"
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class fc ON fc.oid = k.confrelid
      JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      JOIN generate_subscripts(k.conkey, 1) AS i ON TRUE
      JOIN pg_attribute a  ON a.attrelid  = c.oid  AND a.attnum  = k.conkey[i]
      JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = k.confkey[i]
      WHERE k.contype = 'f' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    `);

    const indexes = await sql.unsafe(`
      SELECT schemaname AS "schemaName",
             tablename  AS "tableName",
             indexdef   AS "definition"
      FROM pg_indexes
      WHERE schemaname NOT IN ${SYSTEM_SCHEMAS}
    `);

    return {
      tables: tables.map((t: any) => ({ ...t, rowEstimate: Number(t.rowEstimate) })),
      columns,
      primaryKeys,
      foreignKeys,
      indexes,
    };
  } catch (e: any) {
    throw new Error(scrub(e?.message ?? String(e), url));
  } finally {
    await sql.close().catch(() => {});
  }
}

/**
 * Run one statement under four layers of protection.
 *
 * The guard is layer 2 and gives the model a correctable error. `BEGIN
 * TRANSACTION READ ONLY` is layer 3 and is the actual guarantee — it holds even
 * for a data-modifying CTE the guard failed to spot. Layer 4 is the timeout and
 * the row cap.
 *
 * The cap is applied by wrapping the statement in a subquery rather than by
 * appending LIMIT, which would attach to the wrong clause in a compound query.
 * One extra row is fetched so truncation can be reported without a COUNT.
 */
export async function runReadOnly(
  url: string,
  rawSql: string,
  cap: number = ROW_CAP,
): Promise<QueryOutcome> {
  const guarded = guardReadOnly(rawSql);
  if (!guarded.ok) return { ok: false, error: guarded.reason };

  const bounded = Math.max(1, Math.min(ROW_CAP, cap));
  const isExplain = /^\s*explain\b/i.test(guarded.sql);
  const statement = isExplain
    ? guarded.sql
    : `SELECT * FROM (${guarded.sql}) AS _capped LIMIT ${bounded + 1}`;

  const sql = client(url);
  let inTransaction = false;
  try {
    await sql.unsafe("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    await sql.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    const rows: Record<string, unknown>[] = await sql.unsafe(statement);
    const truncated = !isExplain && rows.length > bounded;
    const shown = truncated ? rows.slice(0, bounded) : rows;

    return {
      ok: true,
      columns: shown.length ? Object.keys(shown[0]!) : [],
      rows: shown,
      truncated,
    };
  } catch (e: any) {
    return { ok: false, error: scrub(e?.message ?? String(e), url) };
  } finally {
    if (inTransaction) await sql.unsafe("ROLLBACK").catch(() => {});
    await sql.close().catch(() => {});
  }
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd apps/api && bunx tsc --noEmit
git add apps/api/src/services/db/postgres.driver.ts
git commit -m "feat: postgres driver with catalog queries and read-only execution"
```

---

### Task 5: Snapshot building and schema reads

**Files:**
- Create: `apps/api/src/services/db/introspect.service.ts`
- Create: `apps/api/src/services/db/introspect.service.test.ts`
- Modify: `apps/api/src/repositories/database-connection.repository.ts` (add snapshot write + three reads)
- Modify: `apps/api/src/repositories/database-connection.repository.test.ts` (add snapshot cases)

**Interfaces:**
- Consumes: `RawCatalog`, `fetchCatalog` from `./postgres.driver`; `databaseConnectionStore` from `../../repositories/database-connection.repository`
- Produces:

```ts
export type SnapshotTable = {
  schemaName: string; name: string; comment: string | null;
  rowEstimate: number; indexes: string[];
  columns: {
    seq: number; name: string; dataType: string; nullable: boolean;
    isPrimaryKey: boolean; fkTable: string | null; fkColumn: string | null;
    comment: string | null;
  }[];
};
export function buildSnapshot(raw: RawCatalog): SnapshotTable[];        // pure
export async function introspectConnection(
  connectionId: string, userId: string, url: string,
  store?: DatabaseConnectionStore,
): Promise<{ ok: true; tableCount: number } | { ok: false; error: string }>;
```

Repository additions:

```ts
saveSnapshot(connectionId: string, userId: string, tables: SnapshotTable[]): Promise<void>;
inventory(userId: string): Promise<ConnectionInventoryEntry[]>;
describeTable(userId: string, connectionName: string, table: string): Promise<TableDetail | null>;
searchSchema(userId: string, ftsQuery: string, connectionName: string | null, limit: number): Promise<SchemaHit[]>;
```

- [ ] **Step 1: Write the failing test for the pure merge**

Create `apps/api/src/services/db/introspect.service.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { RawCatalog } from "./postgres.driver";
import { buildSnapshot } from "./introspect.service";

const catalog = (over: Partial<RawCatalog> = {}): RawCatalog => ({
  tables: [
    { schemaName: "public", name: "orders", comment: "Customer orders", rowEstimate: 1200 },
    { schemaName: "public", name: "customers", comment: null, rowEstimate: 40 },
  ],
  columns: [
    { schemaName: "public", tableName: "orders", seq: 1, name: "id", dataType: "integer", nullable: false, comment: null },
    { schemaName: "public", tableName: "orders", seq: 2, name: "customer_id", dataType: "integer", nullable: false, comment: null },
    { schemaName: "public", tableName: "orders", seq: 3, name: "status", dataType: "text", nullable: true, comment: "P=pending, X=cancelled" },
    { schemaName: "public", tableName: "customers", seq: 1, name: "id", dataType: "integer", nullable: false, comment: null },
  ],
  primaryKeys: [
    { schemaName: "public", tableName: "orders", columnName: "id" },
    { schemaName: "public", tableName: "customers", columnName: "id" },
  ],
  foreignKeys: [
    { schemaName: "public", tableName: "orders", columnName: "customer_id", refSchema: "public", refTable: "customers", refColumn: "id" },
  ],
  indexes: [
    { schemaName: "public", tableName: "orders", definition: "CREATE INDEX idx_orders_status ON public.orders USING btree (status)" },
  ],
  ...over,
});

describe("buildSnapshot", () => {
  it("groups columns under their table in ordinal order", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "customer_id", "status"]);
  });

  it("marks primary keys", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    expect(orders.columns.find((c) => c.name === "id")!.isPrimaryKey).toBe(true);
    expect(orders.columns.find((c) => c.name === "status")!.isPrimaryKey).toBe(false);
  });

  it("attaches the foreign key that makes a join correct", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    const fk = orders.columns.find((c) => c.name === "customer_id")!;
    expect(fk.fkTable).toBe("public.customers");
    expect(fk.fkColumn).toBe("id");
  });

  it("carries table and column comments through", () => {
    const orders = buildSnapshot(catalog()).find((t) => t.name === "orders")!;
    expect(orders.comment).toBe("Customer orders");
    expect(orders.columns.find((c) => c.name === "status")!.comment).toBe("P=pending, X=cancelled");
  });

  it("collects index definitions per table", () => {
    const snap = buildSnapshot(catalog());
    expect(snap.find((t) => t.name === "orders")!.indexes).toHaveLength(1);
    expect(snap.find((t) => t.name === "customers")!.indexes).toEqual([]);
  });

  it("keeps a table that has no columns rather than dropping it", () => {
    const snap = buildSnapshot(catalog({ columns: [] }));
    expect(snap).toHaveLength(2);
    expect(snap[0]!.columns).toEqual([]);
  });

  it("ignores catalog rows for a table that is not listed", () => {
    const snap = buildSnapshot(
      catalog({
        columns: [
          { schemaName: "public", tableName: "ghost", seq: 1, name: "x", dataType: "text", nullable: true, comment: null },
        ],
      }),
    );
    expect(snap.every((t) => t.columns.length === 0)).toBe(true);
  });

  it("distinguishes same-named tables in different schemas", () => {
    const snap = buildSnapshot(
      catalog({
        tables: [
          { schemaName: "public", name: "orders", comment: null, rowEstimate: 1 },
          { schemaName: "archive", name: "orders", comment: null, rowEstimate: 2 },
        ],
        columns: [
          { schemaName: "archive", tableName: "orders", seq: 1, name: "archived_at", dataType: "date", nullable: true, comment: null },
        ],
        primaryKeys: [],
        foreignKeys: [],
        indexes: [],
      }),
    );
    expect(snap.find((t) => t.schemaName === "public")!.columns).toEqual([]);
    expect(snap.find((t) => t.schemaName === "archive")!.columns.map((c) => c.name)).toEqual(["archived_at"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && bun test src/services/db/introspect.service.test.ts`
Expected: FAIL — cannot resolve module `./introspect.service`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/db/introspect.service.ts`:

```ts
import { fetchCatalog, type RawCatalog } from "./postgres.driver";
import {
  databaseConnectionStore,
  type DatabaseConnectionStore,
} from "../../repositories/database-connection.repository";
import { logger } from "../../lib/logger";

/**
 * Turn a database's catalog into the snapshot the agent reads.
 *
 * `buildSnapshot` is pure and holds all the merge logic — five flat result sets
 * folded into one structure. That is where the bugs live (a foreign key attached
 * to the wrong table produces a plausible, wrong join), so it is separated from
 * the I/O and tested exhaustively without a database.
 */

export type SnapshotColumn = {
  seq: number;
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  fkTable: string | null;
  fkColumn: string | null;
  comment: string | null;
};

export type SnapshotTable = {
  schemaName: string;
  name: string;
  comment: string | null;
  rowEstimate: number;
  indexes: string[];
  columns: SnapshotColumn[];
};

const qualify = (schemaName: string, name: string) => `${schemaName}.${name}`;

export function buildSnapshot(raw: RawCatalog): SnapshotTable[] {
  const pkSet = new Set(
    raw.primaryKeys.map((p) => `${qualify(p.schemaName, p.tableName)}.${p.columnName}`),
  );

  const fkMap = new Map<string, { fkTable: string; fkColumn: string }>();
  for (const f of raw.foreignKeys) {
    fkMap.set(`${qualify(f.schemaName, f.tableName)}.${f.columnName}`, {
      fkTable: qualify(f.refSchema, f.refTable),
      fkColumn: f.refColumn,
    });
  }

  const indexMap = new Map<string, string[]>();
  for (const idx of raw.indexes) {
    const key = qualify(idx.schemaName, idx.tableName);
    const list = indexMap.get(key) ?? [];
    list.push(idx.definition);
    indexMap.set(key, list);
  }

  const columnMap = new Map<string, SnapshotColumn[]>();
  for (const c of raw.columns) {
    const key = qualify(c.schemaName, c.tableName);
    const fk = fkMap.get(`${key}.${c.name}`);
    const list = columnMap.get(key) ?? [];
    list.push({
      seq: c.seq,
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: pkSet.has(`${key}.${c.name}`),
      fkTable: fk?.fkTable ?? null,
      fkColumn: fk?.fkColumn ?? null,
      comment: c.comment,
    });
    columnMap.set(key, list);
  }

  // Driven by `raw.tables`, so a column belonging to a table the catalog query
  // excluded (a system table, a dropped relation) cannot conjure one into being.
  return raw.tables.map((t) => {
    const key = qualify(t.schemaName, t.name);
    return {
      schemaName: t.schemaName,
      name: t.name,
      comment: t.comment,
      rowEstimate: t.rowEstimate,
      indexes: indexMap.get(key) ?? [],
      columns: (columnMap.get(key) ?? []).sort((a, b) => a.seq - b.seq),
    };
  });
}

/**
 * Introspect a connection and replace its snapshot.
 *
 * A failure is recorded on the connection rather than thrown: the user added it
 * and needs to see what happened, the same way a PDF that cannot be parsed still
 * gets a row.
 */
export async function introspectConnection(
  connectionId: string,
  userId: string,
  url: string,
  store: DatabaseConnectionStore = databaseConnectionStore,
): Promise<{ ok: true; tableCount: number } | { ok: false; error: string }> {
  try {
    const raw = await fetchCatalog(url);
    const tables = buildSnapshot(raw);
    await store.saveSnapshot(connectionId, userId, tables);
    logger.info("db.introspected", { connectionId, tables: tables.length });
    return { ok: true, tableCount: tables.length };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    await store.markStatus(connectionId, "error", error);
    logger.warn("db.introspect_failed", { connectionId, error });
    return { ok: false, error };
  }
}
```

- [ ] **Step 4: Run the pure tests**

Run: `cd apps/api && bun test src/services/db/introspect.service.test.ts`
Expected: PASS, 8 tests. (`saveSnapshot` does not exist yet — TypeScript will flag it; that is resolved in the next step, and `bun test` runs regardless.)

- [ ] **Step 5: Add the snapshot methods to the repository**

Add to the `DatabaseConnectionStore` interface and `SqliteDatabaseConnectionStore` in `apps/api/src/repositories/database-connection.repository.ts`. Add these imports at the top: `dbTables, dbColumns` from `../db/client`, `type DbColumnRow` from `../models/schema`, and `type SnapshotTable` from `../services/db/introspect.service`.

```ts
export type ConnectionInventoryEntry = { name: string; tableCount: number; tables: string[] };

export type TableDetail = {
  connectionName: string;
  schemaName: string;
  name: string;
  comment: string | null;
  rowEstimate: number;
  indexes: string[];
  columns: DbColumnRow[];
};

export type SchemaHit = {
  connectionName: string;
  schemaName: string;
  tableName: string;
  columnName: string | null;
  detail: string;
  score: number;
};
```

Interface additions:

```ts
  saveSnapshot(connectionId: string, userId: string, tables: SnapshotTable[]): Promise<void>;
  inventory(userId: string): Promise<ConnectionInventoryEntry[]>;
  describeTable(userId: string, connectionName: string, table: string): Promise<TableDetail | null>;
  searchSchema(
    userId: string, ftsQuery: string, connectionName: string | null, limit: number,
  ): Promise<SchemaHit[]>;
```

Class implementations:

```ts
  /**
   * Replace a connection's snapshot wholesale.
   *
   * Delete-then-insert in one transaction rather than a diff: a schema is small,
   * a refresh is rare, and a partial diff would leave the FTS mirror describing
   * columns that no longer exist — which the agent would then write SQL against.
   */
  async saveSnapshot(
    connectionId: string,
    userId: string,
    tables: SnapshotTable[],
  ): Promise<void> {
    this.dbImpl.transaction((tx) => {
      tx.run(sql`DELETE FROM db_schema_fts WHERE connection_id = ${connectionId}`);
      tx.delete(dbTables).where(eq(dbTables.connectionId, connectionId)).run();

      for (const t of tables) {
        const tableId = `${connectionId}:${t.schemaName}.${t.name}`;
        tx.insert(dbTables)
          .values({
            id: tableId,
            connectionId,
            userId,
            schemaName: t.schemaName,
            name: t.name,
            comment: t.comment,
            rowEstimate: t.rowEstimate,
            columnCount: t.columns.length,
            indexes: JSON.stringify(t.indexes),
          })
          .run();

        // The table's own FTS row carries its column names too, so a search for
        // a column term still surfaces the table that holds it.
        tx.run(sql`
          INSERT INTO db_schema_fts (text, object_id, connection_id, kind)
          VALUES (
            ${[t.name, t.comment ?? "", t.columns.map((c) => c.name).join(" ")].join(" ")},
            ${tableId}, ${connectionId}, 'table'
          )
        `);

        for (const c of t.columns) {
          const columnId = `${tableId}#${c.name}`;
          tx.insert(dbColumns)
            .values({
              id: columnId,
              tableId,
              connectionId,
              userId,
              seq: c.seq,
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable ? 1 : 0,
              isPrimaryKey: c.isPrimaryKey ? 1 : 0,
              fkTable: c.fkTable,
              fkColumn: c.fkColumn,
              comment: c.comment,
            })
            .run();

          tx.run(sql`
            INSERT INTO db_schema_fts (text, object_id, connection_id, kind)
            VALUES (
              ${[t.name, c.name, c.comment ?? ""].join(" ")},
              ${columnId}, ${connectionId}, 'column'
            )
          `);
        }
      }

      tx.update(dbConnections)
        .set({
          status: "connected",
          error: null,
          tableCount: tables.length,
          lastIntrospectedAt: Date.now(),
        })
        .where(eq(dbConnections.id, connectionId))
        .run();
    });
  }

  /** Connection names and their table names — everything the system prompt needs. */
  async inventory(userId: string): Promise<ConnectionInventoryEntry[]> {
    const rows = (await this.dbImpl.all(sql`
      SELECT c.name AS connectionName, c.table_count AS tableCount,
             t.schema_name AS schemaName, t.name AS tableName
      FROM db_connections c
      LEFT JOIN db_tables t ON t.connection_id = c.id
      WHERE c.user_id = ${userId} AND c.status = 'connected'
      ORDER BY c.name, t.schema_name, t.name
    `)) as {
      connectionName: string; tableCount: number;
      schemaName: string | null; tableName: string | null;
    }[];

    const byConnection = new Map<string, ConnectionInventoryEntry>();
    for (const r of rows) {
      const entry = byConnection.get(r.connectionName) ?? {
        name: r.connectionName,
        tableCount: r.tableCount,
        tables: [],
      };
      if (r.tableName) {
        // The schema is only shown when it is not `public`, which keeps the
        // common case terse without making a multi-schema database ambiguous.
        entry.tables.push(r.schemaName === "public" ? r.tableName : `${r.schemaName}.${r.tableName}`);
      }
      byConnection.set(r.connectionName, entry);
    }
    return [...byConnection.values()];
  }

  /**
   * Full detail for one table. `table` may be bare (`orders`) or qualified
   * (`public.orders`) — the agent sees both forms in the inventory, so both
   * must resolve.
   */
  async describeTable(
    userId: string,
    connectionName: string,
    table: string,
  ): Promise<TableDetail | null> {
    const [maybeSchema, maybeName] = table.includes(".")
      ? table.split(".", 2)
      : [null, table];

    const rows = (await this.dbImpl.all(sql`
      SELECT t.id AS tableId, t.schema_name AS schemaName, t.name AS name,
             t.comment AS comment, t.row_estimate AS rowEstimate, t.indexes AS indexes
      FROM db_tables t
      JOIN db_connections c ON c.id = t.connection_id
      WHERE c.user_id = ${userId} AND c.name = ${connectionName}
        AND t.name = ${maybeName}
        AND (${maybeSchema} IS NULL OR t.schema_name = ${maybeSchema})
      ORDER BY CASE t.schema_name WHEN 'public' THEN 0 ELSE 1 END
      LIMIT 1
    `)) as {
      tableId: string; schemaName: string; name: string;
      comment: string | null; rowEstimate: number; indexes: string | null;
    }[];

    const hit = rows[0];
    if (!hit) return null;

    const columns = (await this.dbImpl
      .select()
      .from(dbColumns)
      .where(eq(dbColumns.tableId, hit.tableId))
      .orderBy(sql`seq asc`)) as DbColumnRow[];

    return {
      connectionName,
      schemaName: hit.schemaName,
      name: hit.name,
      comment: hit.comment,
      rowEstimate: hit.rowEstimate,
      indexes: hit.indexes ? (JSON.parse(hit.indexes) as string[]) : [],
      columns,
    };
  }

  /** Rank tables and columns against a prepared FTS5 query. */
  async searchSchema(
    userId: string,
    ftsQuery: string,
    connectionName: string | null,
    limit: number,
  ): Promise<SchemaHit[]> {
    return (await this.dbImpl.all(sql`
      SELECT c.name AS connectionName,
             COALESCE(t.schema_name, ct.schema_name) AS schemaName,
             COALESCE(t.name, ct.name)              AS tableName,
             col.name                                AS columnName,
             CASE
               WHEN col.id IS NOT NULL
                 THEN col.data_type || COALESCE(' — ' || col.comment, '')
               ELSE COALESCE(t.comment, t.column_count || ' columns')
             END AS detail,
             -bm25(db_schema_fts) AS score
      FROM db_schema_fts
      JOIN db_connections c ON c.id = db_schema_fts.connection_id
      LEFT JOIN db_tables  t   ON t.id   = db_schema_fts.object_id
      LEFT JOIN db_columns col ON col.id = db_schema_fts.object_id
      LEFT JOIN db_tables  ct  ON ct.id  = col.table_id
      WHERE db_schema_fts MATCH ${ftsQuery}
        AND c.user_id = ${userId}
        AND (${connectionName} IS NULL OR c.name = ${connectionName})
      ORDER BY score DESC
      LIMIT ${limit}
    `)) as SchemaHit[];
  }
```

- [ ] **Step 6: Add repository tests for the snapshot**

Append to `apps/api/src/repositories/database-connection.repository.test.ts`:

```ts
import type { SnapshotTable } from "../services/db/introspect.service";

const snapshot: SnapshotTable[] = [
  {
    schemaName: "public",
    name: "orders",
    comment: "Customer orders",
    rowEstimate: 1200,
    indexes: ["CREATE INDEX idx_orders_status ON public.orders USING btree (status)"],
    columns: [
      { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
      { seq: 2, name: "customer_id", dataType: "integer", nullable: false, isPrimaryKey: false, fkTable: "public.customers", fkColumn: "id", comment: null },
    ],
  },
  {
    schemaName: "public",
    name: "refunds",
    comment: null,
    rowEstimate: 8,
    indexes: [],
    columns: [
      { seq: 1, name: "reason", dataType: "text", nullable: true, isPrimaryKey: false, fkTable: null, fkColumn: null, comment: null },
    ],
  },
];

describe("snapshot", () => {
  beforeEach(async () => {
    await store.create(conn());
    await store.saveSnapshot("c1", "u1", snapshot);
  });

  it("records the table count and clears any prior error", async () => {
    const row = (await store.list("u1"))[0]!;
    expect(row.tableCount).toBe(2);
    expect(row.status).toBe("connected");
    expect(row.lastIntrospectedAt).toBeGreaterThan(0);
  });

  it("builds an inventory the system prompt can use", async () => {
    const inv = await store.inventory("u1");
    expect(inv).toHaveLength(1);
    expect(inv[0]!.name).toBe("sales");
    expect(inv[0]!.tables).toEqual(["orders", "refunds"]);
  });

  it("describes a table by its bare name", async () => {
    const detail = await store.describeTable("u1", "sales", "orders");
    expect(detail?.comment).toBe("Customer orders");
    expect(detail?.columns.map((c) => c.name)).toEqual(["id", "customer_id"]);
    expect(detail?.indexes).toHaveLength(1);
  });

  it("describes a table by its qualified name", async () => {
    expect((await store.describeTable("u1", "sales", "public.orders"))?.name).toBe("orders");
  });

  it("preserves the foreign key that makes a join correct", async () => {
    const detail = await store.describeTable("u1", "sales", "orders");
    const fk = detail!.columns.find((c) => c.name === "customer_id")!;
    expect(fk.fkTable).toBe("public.customers");
    expect(fk.fkColumn).toBe("id");
  });

  it("returns null for an unknown table", async () => {
    expect(await store.describeTable("u1", "sales", "ghost")).toBeNull();
  });

  it("does not describe a table belonging to another user", async () => {
    expect(await store.describeTable("u2", "sales", "orders")).toBeNull();
  });

  it("finds a table by a stemmed term", async () => {
    const hits = await store.searchSchema("u1", '"refund"', null, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.tableName === "refunds")).toBe(true);
  });

  it("finds a column and reports the table that holds it", async () => {
    const hits = await store.searchSchema("u1", '"customer_id"', null, 5);
    const hit = hits.find((h) => h.columnName === "customer_id");
    expect(hit?.tableName).toBe("orders");
  });

  it("scopes search to one connection when asked", async () => {
    expect(await store.searchSchema("u1", '"orders"', "nonexistent", 5)).toHaveLength(0);
  });

  it("replaces the previous snapshot rather than appending to it", async () => {
    await store.saveSnapshot("c1", "u1", [snapshot[0]!]);
    expect((await store.inventory("u1"))[0]!.tables).toEqual(["orders"]);
    expect(await store.searchSchema("u1", '"refund"', null, 5)).toHaveLength(0);
  });

  it("drops the snapshot and its search index when the connection is removed", async () => {
    await store.remove("u1", "c1");
    expect(await store.searchSchema("u1", '"orders"', null, 5)).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run everything**

Run: `cd apps/api && bun test src/repositories/database-connection.repository.test.ts src/services/db/`
Expected: PASS — 10 original + 12 snapshot + 8 introspect + 31 guard.

- [ ] **Step 8: Type-check and commit**

```bash
cd apps/api && bunx tsc --noEmit
git add apps/api/src/services/db/introspect.service.ts \
        apps/api/src/services/db/introspect.service.test.ts \
        apps/api/src/repositories/database-connection.repository.ts \
        apps/api/src/repositories/database-connection.repository.test.ts
git commit -m "feat: schema snapshot building, storage, and search"
```

---

### Task 6: The three agent tools

**Files:**
- Create: `apps/api/src/services/db-tools.ts`
- Create: `apps/api/src/services/db-tools.test.ts`

**Interfaces:**
- Consumes: `databaseConnectionStore`, `toFtsQuery` from `./search.service`, `runReadOnly` / `ROW_CAP` from `./db/postgres.driver`
- Produces: `createDatabaseTools(userId: string, store?: DatabaseConnectionStore, execute?: typeof runReadOnly): any[]` — three tool descriptors shaped exactly like `createDocumentTools`, each with `{ name, label, description, parameters, execute }`.

The `execute` parameter exists so the tool layer is testable without a Postgres server. It defaults to the real driver.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/db-tools.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteDatabaseConnectionStore } from "../repositories/database-connection.repository";
import type { QueryOutcome } from "./db/postgres.driver";
import type { SnapshotTable } from "./db/introspect.service";
import { createDatabaseTools } from "./db-tools";

(env as { connectionSecret: string }).connectionSecret = "test-secret";

const snapshot: SnapshotTable[] = [
  {
    schemaName: "public", name: "orders", comment: "Customer orders", rowEstimate: 1200, indexes: [],
    columns: [
      { seq: 1, name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, fkTable: null, fkColumn: null, comment: null },
      { seq: 2, name: "customer_id", dataType: "integer", nullable: false, isPrimaryKey: false, fkTable: "public.customers", fkColumn: "id", comment: null },
    ],
  },
];

let store: SqliteDatabaseConnectionStore;
let lastSql: string | null;
let outcome: QueryOutcome;

const toolsFor = () =>
  createDatabaseTools("u1", store, async (_url, sql) => {
    lastSql = sql;
    return outcome;
  });

const tool = (name: string) => toolsFor().find((t) => t.name === name)!;
const textOf = (result: any) => result.content[0].text as string;

beforeEach(async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  store = new SqliteDatabaseConnectionStore(drizzle(sqlite) as any);
  await store.create({
    id: "c1", userId: "u1", name: "sales",
    url: "postgres://reader:hunter2@db.example.com:5432/sales",
    displayHost: "db.example.com", displayDatabase: "sales",
  });
  await store.saveSnapshot("c1", "u1", snapshot);
  lastSql = null;
  outcome = { ok: true, columns: ["count"], rows: [{ count: 3 }], truncated: false };
});

describe("createDatabaseTools", () => {
  it("exposes exactly search_schema, describe_table, and run_query", () => {
    expect(toolsFor().map((t) => t.name).sort()).toEqual([
      "describe_table", "run_query", "search_schema",
    ]);
  });

  it("describes a table with its types and foreign keys", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "orders" }));
    expect(out).toContain("customer_id");
    expect(out).toContain("integer");
    expect(out).toContain("public.customers.id");
  });

  it("never returns sample rows from describe_table", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "orders" }));
    expect(lastSql).toBeNull(); // it must not query the database at all
    expect(out.toLowerCase()).not.toContain("sample");
  });

  it("tells the agent which tables exist when it names an unknown one", async () => {
    const out = textOf(await tool("describe_table").execute("1", { connection: "sales", table: "ghost" }));
    expect(out).toContain("orders");
  });

  it("lists valid connection names when the agent names an unknown one", async () => {
    const out = textOf(await tool("run_query").execute("1", { connection: "nope", sql: "SELECT 1" }));
    expect(out).toContain("sales");
  });

  it("finds a table through search_schema", async () => {
    const out = textOf(await tool("search_schema").execute("1", { query: "orders" }));
    expect(out).toContain("orders");
  });

  it("reports no match rather than returning an empty result", async () => {
    const out = textOf(await tool("search_schema").execute("1", { query: "zzzznothing" }));
    expect(out.toLowerCase()).toContain("no schema");
  });

  it("runs a query and renders the rows", async () => {
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT count(*) FROM orders" }));
    expect(lastSql).toBe("SELECT count(*) FROM orders");
    expect(out).toContain("3");
  });

  it("returns a query error as text so the loop can retry", async () => {
    outcome = { ok: false, error: 'column "totl" does not exist' };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT totl FROM orders" }));
    expect(out).toContain("totl");
  });

  it("reports truncation so the agent aggregates instead of paginating", async () => {
    outcome = {
      ok: true, columns: ["id"],
      rows: Array.from({ length: 100 }, (_, i) => ({ id: i })), truncated: true,
    };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT id FROM orders" }));
    expect(out.toLowerCase()).toContain("more exist");
  });

  it("says so plainly when a query returns nothing", async () => {
    outcome = { ok: true, columns: [], rows: [], truncated: false };
    const out = textOf(await tool("run_query").execute("1", { connection: "sales", sql: "SELECT 1 WHERE false" }));
    expect(out.toLowerCase()).toContain("no rows");
  });

  it("never leaks the connection string into a tool result", async () => {
    outcome = { ok: false, error: "connection refused" };
    for (const t of toolsFor()) {
      const out = textOf(await t.execute("1", { connection: "sales", table: "orders", query: "orders", sql: "SELECT 1" }));
      expect(out).not.toContain("hunter2");
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && bun test src/services/db-tools.test.ts`
Expected: FAIL — cannot resolve module `./db-tools`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/db-tools.ts`:

```ts
import {
  databaseConnectionStore,
  type DatabaseConnectionStore,
  type TableDetail,
} from "../repositories/database-connection.repository";
import { toFtsQuery } from "./search.service";
import { ROW_CAP, runReadOnly, type QueryOutcome } from "./db/postgres.driver";

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
  /** Resolve a connection name to its id and url, or explain what is available. */
  async function resolve(name: string) {
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
    const url = await store.resolveUrl(userId, hit.id);
    if (!url) return { ok: false as const, message: `unknown database "${trimmed}"` };
    return { ok: true as const, row: hit, url };
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
        const found = await resolve(params?.connection);
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
        const found = await resolve(params?.connection);
        if (!found.ok) return text(found.message);

        const statement = String(params?.sql ?? "").trim();
        if (!statement) return text("error: sql required");

        const cap = Math.max(1, Math.min(ROW_CAP, Number(params?.limit ?? ROW_CAP) || ROW_CAP));
        const outcome = await execute(found.url, statement, cap);
        return text(renderOutcome(outcome, cap));
      },
    },
  ];
}

function renderTable(detail: TableDetail): string {
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

  return `${head}\nColumns:\n${columns}${indexes}`;
}

function renderOutcome(outcome: QueryOutcome, cap: number): string {
  if (!outcome.ok) return `query failed: ${outcome.error}`;
  if (!outcome.rows.length) return "no rows";

  const header = outcome.columns.join(" | ");
  const body = outcome.rows
    .map((r) => outcome.columns.map((c) => format(r[c])).join(" | "))
    .join("\n");
  const note = outcome.truncated
    ? `\n\n(showing the first ${cap} rows — more exist. Aggregate in SQL rather than paginating.)`
    : "";

  return `${header}\n${"-".repeat(header.length)}\n${body}${note}`;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function text(out: string) {
  return { content: [{ type: "text" as const, text: out }], details: { output: out } };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bun test src/services/db-tools.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Type-check and commit**

```bash
cd apps/api && bunx tsc --noEmit
git add apps/api/src/services/db-tools.ts apps/api/src/services/db-tools.test.ts
git commit -m "feat: search_schema, describe_table, and run_query agent tools"
```

---

### Task 7: The db-analyst harness

**Files:**
- Modify: `apps/api/src/catalog/harnesses.ts`
- Modify: `apps/api/src/services/pi.service.ts`

**Interfaces:**
- Consumes: `createDatabaseTools` from `./db-tools`, `databaseConnectionStore` from `../repositories/database-connection.repository`
- Produces: `Harness.tools?: string[]` — an optional capability gate. A harness with `tools: ["db"]` gets the database tools and the inventory prompt; every other harness is unchanged.

- [ ] **Step 1: Add the harness entry**

In `apps/api/src/catalog/harnesses.ts`, add to the `Harness` type:

```ts
  /**
   * Optional capability gates. A harness only receives the tool groups it names,
   * so the general agent's tool list and system prompt stay small.
   */
  tools?: string[];
```

Add the prompt and the entry:

```ts
const DB_PROMPT = `You are a database analyst running inside the pi agent harness, with
read-only access to the user's connected databases.

Work in three steps and do not skip them:
1. If you do not already know which table holds the answer, call "search_schema".
2. Call "describe_table" on every table you intend to query. It gives you exact
   column names, types, and the foreign keys a correct join needs. Never write SQL
   against a table you have not described — guessing a column name wastes a turn.
3. Call "run_query" with a single SELECT.

The connection is read-only and enforced as such: only SELECT, WITH, and EXPLAIN
run. Results are capped and the statement is cancelled after 10 seconds, so
aggregate in SQL (COUNT, SUM, GROUP BY) rather than fetching rows to count them
yourself.

When a query fails, read the error — it is the real message from the database —
fix the SQL and try again. When you answer, state which tables the numbers came
from, and show the SQL you ran.`;
```

```ts
  {
    id: "db-analyst",
    label: "db analyst (pi harness)",
    description: "Read-only SQL analyst: introspects the schema, then queries it.",
    tagline: "Schema-first · read-only SQL · REAL runtime",
    systemPrompt: DB_PROMPT,
    driver: "pi",
    tools: ["db"],
    maxIterations: 10,
  },
```

- [ ] **Step 2: Thread the harness into the pi runtime**

`runPiAgent` currently receives `systemPrompt` but not the harness. In `apps/api/src/services/agent.service.ts`, change the `runPiAgent` call to pass the harness through:

```ts
  if (harness.driver === "pi") {
    return runPiAgent({
      model,
      systemPrompt: harness.systemPrompt,
      harnessTools: harness.tools ?? [],
      history,
      emit,
      signal,
      runId,
      template,
      workspace,
      userId,
    });
  }
```

In `apps/api/src/services/pi.service.ts`, add `harnessTools?: string[]` to the `opts` type and destructure it with a default of `[]`.

- [ ] **Step 3: Inject the tools and the inventory prompt**

In `pi.service.ts`, add the imports:

```ts
import { createDatabaseTools } from "./db-tools";
import { databaseConnectionStore } from "../repositories/database-connection.repository";
```

Immediately after the `createDocumentTools` loop (currently around line 161), add:

```ts
  // --- context layer: read-only database access, only where a harness asks ---
  // Gated rather than always-on: the inventory prompt and three extra tools are
  // dead weight on a run that will never touch a database.
  if (harnessTools.includes("db")) {
    for (const dbt of createDatabaseTools(userId)) {
      agentTools.push({
        name: dbt.name,
        description: dbt.description,
        parameters: JSON_SCHEMA_TO_TYPEBOX(dbt.parameters as Record<string, unknown>),
        label: dbt.name,
        execute: dbt.execute,
      });
    }
  }
```

After the `docsPrompt` block (currently ending around line 210), add:

```ts
  // Table names, not table structures. Naming the corpus is what turns the
  // schema tools from ones the model *could* call into ones it knows are worth
  // calling; loading full structure here would not survive a real schema.
  let dbPrompt = "";
  if (harnessTools.includes("db")) {
    try {
      const inventory = await databaseConnectionStore.inventory(userId);
      if (inventory.length) {
        dbPrompt =
          `\n\nConnected databases:\n` +
          inventory
            .map(
              (c) =>
                `- "${c.name}" — ${c.tableCount} table(s): ` +
                (c.tables.length > 60
                  ? `${c.tables.slice(0, 60).join(", ")}, … (${c.tables.length - 60} more — use search_schema)`
                  : c.tables.join(", ")),
            )
            .join("\n") +
          `\nThese are table names only. Call "describe_table" for columns and foreign keys ` +
          `before writing SQL against any of them.`;
      } else {
        dbPrompt =
          `\n\nNo databases are connected yet. Say so if the user asks you to query one.`;
      }
    } catch (e: any) {
      logger.warn("db.inventory_failed", { userId, message: e?.message ?? String(e) });
    }
  }
```

In `systemPromptFn`, add `if (dbPrompt) out += dbPrompt;` after the `docsPrompt` line.

- [ ] **Step 4: Verify the general harness is unchanged**

Run: `cd apps/api && bun test && bunx tsc --noEmit`
Expected: PASS. Then start the API (`bun run dev:api`) and confirm `GET /api/meta` lists both `pi` and `db-analyst`:

```bash
curl -s localhost:4000/api/meta | grep -o '"id":"[^"]*"'
```

Expected: includes `"id":"pi"` and `"id":"db-analyst"`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/catalog/harnesses.ts apps/api/src/services/pi.service.ts \
        apps/api/src/services/agent.service.ts
git commit -m "feat: db-analyst harness with gated database tools"
```

---

### Task 8: HTTP surface

**Files:**
- Create: `apps/api/src/controllers/database.controller.ts`
- Create: `apps/api/src/routes/database.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

**Interfaces:**
- Consumes: `databaseConnectionStore`, `introspectConnection`, `probe`
- Produces: four endpoints under `/api/databases`, matching the table in the spec.

- [ ] **Step 1: Implement the controller**

Create `apps/api/src/controllers/database.controller.ts`:

```ts
import type { Context } from "hono";
import { databaseConnectionStore } from "../repositories/database-connection.repository";
import { introspectConnection } from "../services/db/introspect.service";
import { probe } from "../services/db/postgres.driver";
import { env } from "../config/env";
import { logger } from "../lib/logger";

const userIdOf = (c: Context) => c.req.query("userId") ?? env.defaultUserId;

const newConnectionId = () =>
  `db_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Names reach the model, so they are constrained to something unambiguous. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/i;

/** GET /api/databases — a user's connections, newest first, never with a secret. */
export async function index(c: Context) {
  const connections = await databaseConnectionStore.list(userIdOf(c));
  return c.json({ connections });
}

/**
 * POST /api/databases — add a connection, then introspect it.
 *
 * A database that cannot be reached is still stored, with the reason, so the
 * user can see and fix it. Only a genuinely invalid request is rejected outright.
 */
export async function create(c: Context) {
  const userId = userIdOf(c);

  if (!env.connectionSecret) {
    return c.json(
      { error: "CONNECTION_SECRET is not set — the API will not store a database credential" },
      503,
    );
  }

  let body: { name?: string; url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const name = String(body.name ?? "").trim();
  const url = String(body.url ?? "").trim();
  if (!NAME_PATTERN.test(name)) {
    return c.json({ error: "Name must be 1-31 letters, digits, hyphens or underscores" }, 400);
  }
  if (!url) return c.json({ error: "A connection URL is required" }, 400);

  if (await databaseConnectionStore.findByName(userId, name)) {
    return c.json({ error: `A connection named "${name}" already exists` }, 409);
  }

  const reached = await probe(url);
  const id = newConnectionId();

  // Host and database come from the URL even when the probe failed, so a broken
  // connection is still identifiable in the list.
  let displayHost = "unknown";
  let displayDatabase = "unknown";
  try {
    const parsed = new URL(url);
    displayHost = parsed.hostname;
    displayDatabase = parsed.pathname.replace(/^\//, "") || "postgres";
  } catch {
    // probe() already reported this; the placeholders stand.
  }

  await databaseConnectionStore.create({ id, userId, name, url, displayHost, displayDatabase });

  if (!reached.ok) {
    await databaseConnectionStore.markStatus(id, "error", reached.error);
    logger.warn("db.connect_failed", { id, name, error: reached.error });
    return c.json({ connection: (await databaseConnectionStore.list(userId))[0] }, 201);
  }

  await introspectConnection(id, userId, url);
  const connection = (await databaseConnectionStore.list(userId)).find((r) => r.id === id);
  return c.json({ connection }, 201);
}

/** POST /api/databases/:id/refresh — re-introspect an existing connection. */
export async function refresh(c: Context) {
  const userId = userIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing connection id" }, 400);

  const url = await databaseConnectionStore.resolveUrl(userId, id);
  if (!url) return c.json({ error: "Connection not found" }, 404);

  await introspectConnection(id, userId, url);
  const connection = (await databaseConnectionStore.list(userId)).find((r) => r.id === id);
  return c.json({ connection });
}

/** DELETE /api/databases/:id — removes the snapshot and its search index too. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing connection id" }, 400);

  const removed = await databaseConnectionStore.remove(userIdOf(c), id);
  if (!removed) return c.json({ error: "Connection not found" }, 404);
  return c.body(null, 204);
}
```

- [ ] **Step 2: Mount the routes**

Create `apps/api/src/routes/database.routes.ts`:

```ts
import { Hono } from "hono";
import * as databaseController from "../controllers/database.controller";

export const databaseRoutes = new Hono();

databaseRoutes.get("/", databaseController.index);
databaseRoutes.post("/", databaseController.create);
databaseRoutes.post("/:id/refresh", databaseController.refresh);
databaseRoutes.delete("/:id", databaseController.destroy);
```

In `apps/api/src/routes/index.ts`, add the import and `apiRoutes.route("/databases", databaseRoutes);`.

- [ ] **Step 3: Verify by hand**

Start the API (`bun run dev:api`), then:

```bash
# No secret configured yet -> 503 with a clear reason
curl -s -X POST localhost:4000/api/databases -H 'content-type: application/json' \
  -d '{"name":"sales","url":"postgres://x@localhost/sales"}'

# With CONNECTION_SECRET set and an unreachable host -> 201, status "error"
curl -s -X POST localhost:4000/api/databases -H 'content-type: application/json' \
  -d '{"name":"nope","url":"postgres://x@127.0.0.1:1/none"}' | head -c 400

# Listing never contains a password
curl -s localhost:4000/api/databases
```

Expected: the 503 names `CONNECTION_SECRET`; the unreachable connection is stored with `"status":"error"` and a reason; no response contains a password.

- [ ] **Step 4: Commit**

```bash
cd apps/api && bunx tsc --noEmit
git add apps/api/src/controllers/database.controller.ts \
        apps/api/src/routes/database.routes.ts apps/api/src/routes/index.ts
git commit -m "feat: database connection endpoints"
```

---

### Task 9: Console panel

**Files:**
- Create: `apps/web/src/components/database-panel.tsx`
- Modify: `apps/web/src/lib/types.ts` (add `DbConnectionRow`)
- Modify: `apps/web/src/lib/api.ts` (add four calls)
- Modify: `apps/web/src/components/control-deck.tsx` (render the panel below `DocumentPanel`)

**Interfaces:**
- Consumes: `getUserId` from `@/lib/user`
- Produces: `<DatabasePanel />`, and in `@/lib/api`: `listConnections(userId)`, `addConnection(userId, name, url)`, `refreshConnection(userId, id)`, `deleteConnection(userId, id)`

- [ ] **Step 1: Add the type**

Append to `apps/web/src/lib/types.ts`:

```ts
export type DbConnectionRow = {
  id: string
  name: string
  engine: string
  status: 'connected' | 'error'
  error: string | null
  displayHost: string
  displayDatabase: string
  tableCount: number
  lastIntrospectedAt: number | null
  createdAt: number
}
```

- [ ] **Step 2: Add the API calls**

Append to `apps/web/src/lib/api.ts`, following the existing `listDocuments` / `deleteDocument` style in that file:

```ts
export async function listConnections(userId: string): Promise<DbConnectionRow[]> {
  const res = await fetch(`${API}/databases?userId=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`listConnections failed: ${res.status}`)
  return (await res.json()).connections
}

export async function addConnection(
  userId: string,
  name: string,
  url: string,
): Promise<{ connection?: DbConnectionRow; error?: string }> {
  const res = await fetch(`${API}/databases?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, url }),
  })
  return await res.json()
}

export async function refreshConnection(userId: string, id: string): Promise<void> {
  await fetch(`${API}/databases/${id}/refresh?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  })
}

export async function deleteConnection(userId: string, id: string): Promise<void> {
  await fetch(`${API}/databases/${id}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}
```

Import `DbConnectionRow` from `./types` alongside the existing type imports. Match the file's existing `API` base-URL constant — do not introduce a second one.

- [ ] **Step 3: Build the panel**

Create `apps/web/src/components/database-panel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangleIcon, DatabaseIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { addConnection, deleteConnection, listConnections, refreshConnection } from '@/lib/api'
import { getUserId } from '@/lib/user'
import type { DbConnectionRow } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Connect a read-only Postgres database and see what the agent can query.
 *
 * A connection that failed to introspect is listed alongside the ones that
 * worked, carrying its reason — the same stance the document panel takes, and
 * for the same reason: an unreachable database looks exactly like an empty one
 * until the agent says it found nothing.
 */
export function DatabasePanel() {
  const [connections, setConnections] = useState<DbConnectionRow[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setConnections(await listConnections(getUserId()))
    } catch {
      // Secondary to the console; a listing failure is not fatal.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = useCallback(async () => {
    if (!name.trim() || !url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const out = await addConnection(getUserId(), name.trim(), url.trim())
      if (out.error) {
        setError(out.error)
        return
      }
      setName('')
      setUrl('')
      setAdding(false)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [name, url, refresh])

  const connected = connections.filter((c) => c.status === 'connected')
  const tableTotal = connected.reduce((n, c) => n + c.tableCount, 0)

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="label text-muted-foreground">Databases</h2>
        {connected.length ? (
          <span className="readout text-[0.625rem] text-muted-foreground">
            {connected.length} db{connected.length === 1 ? '' : 's'} · {tableTotal} tables
          </span>
        ) : null}
        {busy ? <Spinner className="ml-auto size-3.5 text-muted-foreground" /> : null}
      </div>

      {adding ? (
        <div className="flex flex-col gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name, e.g. sales"
            className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-foreground/30"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="postgres://readonly@host:5432/db"
            className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-foreground/30"
          />
          {error ? <p className="text-[0.625rem] text-muted-foreground">{error}</p> : null}
          <div className="flex gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void submit()} className="flex-1">
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2.5',
            'text-xs text-muted-foreground transition-colors',
            'hover:border-foreground/30 hover:text-foreground',
          )}
        >
          <PlusIcon className="size-3.5" />
          Connect a read-only database
        </button>
      )}

      {connections.length ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {connections.map((c) => (
            <ConnectionItem
              key={c.id}
              connection={c}
              onRefresh={async () => {
                setBusy(true)
                try {
                  await refreshConnection(getUserId(), c.id)
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
              onRemove={async () => {
                setConnections((prev) => prev.filter((x) => x.id !== c.id)) // optimistic
                await deleteConnection(getUserId(), c.id)
                await refresh()
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ConnectionItem({
  connection,
  onRefresh,
  onRemove,
}: {
  connection: DbConnectionRow
  onRefresh: () => Promise<void>
  onRemove: () => Promise<void>
}) {
  const failed = connection.status !== 'connected'
  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      {failed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{connection.error ?? 'unreachable'}</TooltipContent>
        </Tooltip>
      ) : (
        <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}

      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-xs', failed && 'text-muted-foreground')}>
          {connection.name}
        </span>
        <span className="readout block truncate text-[0.625rem] text-muted-foreground">
          {failed
            ? 'could not connect'
            : `${connection.displayDatabase} @ ${connection.displayHost} · ${connection.tableCount} tables`}
        </span>
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onRefresh()}
        aria-label={`Refresh ${connection.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <RefreshCwIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onRemove()}
        aria-label={`Remove ${connection.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2Icon />
      </Button>
    </li>
  )
}
```

- [ ] **Step 4: Render it in the deck**

In `apps/web/src/components/control-deck.tsx`, import `DatabasePanel` and render `<DatabasePanel />` directly below `<DocumentPanel />`, wrapped in whatever spacing element the neighbouring panels already use.

- [ ] **Step 5: Verify in the browser**

Run: `bun run dev`, open http://localhost:5173.
Expected: a "Databases" panel below "Context". Adding an unreachable URL lists it with a warning icon whose tooltip carries the reason. Removing it clears it.

Run: `cd apps/web && bun run build && bun run lint`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/database-panel.tsx apps/web/src/components/control-deck.tsx \
        apps/web/src/lib/api.ts apps/web/src/lib/types.ts
git commit -m "feat: database connections panel in the console"
```

---

### Task 10: Read-only proof and documentation

**Files:**
- Create: `apps/api/scripts/db-connector-check.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `runReadOnly`, `probe`, `fetchCatalog` from `../src/services/db/postgres.driver`; `buildSnapshot` from `../src/services/db/introspect.service`

- [ ] **Step 1: Write the check script**

Create `apps/api/scripts/db-connector-check.ts`:

```ts
/**
 * Prove the read-only guarantee against a real PostgreSQL server.
 *
 * The unit tests cover the statement guard exhaustively, but a passing guard
 * test says nothing about whether the transaction layer works — and the
 * transaction is the layer that actually protects the database. This script
 * bypasses the guard and sends a write directly, so a failure here means the
 * real defence is broken.
 *
 *   DB_CHECK_URL=postgres://user:pass@host:5432/db bun scripts/db-connector-check.ts
 */
import { fetchCatalog, probe, runReadOnly } from "../src/services/db/postgres.driver";
import { buildSnapshot } from "../src/services/db/introspect.service";

const url = process.env.DB_CHECK_URL;
if (!url) {
  console.error("Set DB_CHECK_URL to a PostgreSQL connection string.");
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const reached = await probe(url);
check("connects", reached.ok, reached.ok ? `${reached.database} @ ${reached.host}` : reached.error);
if (!reached.ok) process.exit(1);

const catalog = await fetchCatalog(url);
const snapshot = buildSnapshot(catalog);
check("introspects", snapshot.length > 0, `${snapshot.length} tables`);
check(
  "captures foreign keys",
  catalog.foreignKeys.length === 0 ||
    snapshot.some((t) => t.columns.some((c) => c.fkTable !== null)),
  `${catalog.foreignKeys.length} in catalog`,
);

const select = await runReadOnly(url, "SELECT 1 AS one");
check("runs a select", select.ok && select.rows.length === 1);

const capped = await runReadOnly(url, "SELECT generate_series(1, 500) AS n", 10);
check("caps rows", capped.ok && capped.rows.length === 10 && capped.truncated);

const blocked = await runReadOnly(url, "CREATE TABLE salurai_should_not_exist (id int)");
check("guard rejects a write", !blocked.ok, blocked.ok ? "" : blocked.error);

// The guard is bypassed here on purpose: this is the only assertion that tests
// the transaction layer rather than the string check in front of it.
const sql = new Bun.SQL({ url, max: 1 });
let engineBlocked = false;
let engineDetail = "";
try {
  await sql.unsafe("BEGIN TRANSACTION READ ONLY");
  await sql.unsafe("CREATE TABLE salurai_should_not_exist (id int)");
} catch (e: any) {
  engineBlocked = true;
  engineDetail = e?.message ?? String(e);
} finally {
  await sql.unsafe("ROLLBACK").catch(() => {});
  await sql.close().catch(() => {});
}
check("READ ONLY transaction rejects a write with the guard bypassed", engineBlocked, engineDetail);

const timeout = await runReadOnly(url, "SELECT pg_sleep(30)");
check("cancels a slow statement", !timeout.ok, timeout.ok ? "" : timeout.error);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it against a real Postgres**

```bash
cd apps/api && DB_CHECK_URL=postgres://user:pass@host:5432/db bun scripts/db-connector-check.ts
```

Expected: every line `ok`, ending `all checks passed`. If `READ ONLY transaction rejects a write with the guard bypassed` fails, stop — the primary defence is not working, and no amount of guard testing compensates. Check that `max: 1` is set on the client, since the BEGIN and the write must land on the same backend.

If `cancels a slow statement` fails, `SET LOCAL statement_timeout` is not taking effect — confirm it runs *inside* the transaction.

- [ ] **Step 3: Document it**

Add to `README.md`, after the "Sandboxed workspaces" section:

````markdown
### Connected databases

The `db-analyst` harness can query a user's PostgreSQL databases, read-only. A
connection is added in the console, encrypted with `CONNECTION_SECRET`, and
introspected once into a schema snapshot the agent searches.

```bash
CONNECTION_SECRET=$(openssl rand -base64 32)   # required, else connections are refused
```

The agent works schema-first: `search_schema` finds candidate tables,
`describe_table` returns exact columns and foreign keys, and only then does
`run_query` execute a SELECT. Full schema is never pre-loaded — the system prompt
carries table names only, so a thousand-table database costs the same as a
ten-table one.

Read-only is enforced in four layers:

| Layer | Mechanism |
| --- | --- |
| Operator | Point the connection at a `GRANT SELECT`-only role |
| Statement | Only `SELECT` / `WITH` / `EXPLAIN`; write keywords rejected anywhere in the statement |
| Transaction | `BEGIN TRANSACTION READ ONLY`, always rolled back |
| Budget | 10s `statement_timeout`, 100-row cap |

The statement guard exists to give the model a correctable error message. The
transaction is the actual guarantee — Postgres allows data-modifying CTEs, so
`WITH x AS (DELETE ... RETURNING *) SELECT * FROM x` begins with `WITH` and
writes, and only the transaction catches it unconditionally.

The model never receives a connection string. Tools take a connection name and
the credential is resolved server-side, so a prompt-injected document cannot ask
the agent to reveal it.

Prove the guarantee against your own server:

```bash
cd apps/api && DB_CHECK_URL=postgres://... bun scripts/db-connector-check.ts
```

**Not yet safe for production data.** Connections are stored against a `userId`
the browser generates, with no authentication — anyone who forges one can use
that user's connections. Encryption protects `app.db` at rest, not the API.
````

Add `search_schema`, `describe_table`, and `run_query` to the Tools table in the README, noting they are available on the `db-analyst` harness only.

- [ ] **Step 4: Full verification and commit**

```bash
cd apps/api && bun test && bunx tsc --noEmit
cd ../web && bun run build && bun run lint
git add apps/api/scripts/db-connector-check.ts README.md
git commit -m "feat: read-only proof script and connector documentation"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Engine / driver decision (Postgres, `Bun.SQL`, no abstraction) | 4 |
| Per-user connections in the UI | 8, 9 |
| Credential storage (AES-256-GCM, `CONNECTION_SECRET`) | 1 |
| Credential never exposed to the model | 6 (tools take a name; `scrub` in 4) |
| Snapshot in structured tables + FTS mirror | 3, 5 |
| No sample rows | 6 (asserted by test) |
| `db-analyst` harness, `driver: "pi"` | 7 |
| Tool gating | 7 |
| Three tools | 6 |
| Inventory in the system prompt | 7 |
| Four-layer read-only enforcement | 2 (layer 2), 4 (layers 3–4), 10 (proof), 10 README (layer 1) |
| `limit` may only lower the cap | 4, 6 |
| Data flow / introspect on add and refresh | 5, 8 |
| Endpoints | 8 |
| Console panel | 9 |
| Error handling — failures recorded not dropped | 5 (`introspectConnection`), 8 (`create`) |
| Error handling — SQL error returned as text | 6 |
| Error handling — truncation reported | 6 |
| Error handling — missing `CONNECTION_SECRET` refuses loudly | 1, 8 |
| Error handling — unknown connection name lists valid ones | 6 |
| Testing table | 1, 2, 3, 5, 6, 10 |
| Known limitations documented | 10 (README) |

No gaps.

**Type consistency:** `SnapshotTable` is defined in Task 5 and consumed by name in Tasks 5 (repository) and 6 (test fixture). `QueryOutcome`, `RawCatalog`, `Probe`, and `ROW_CAP` are defined in Task 4 and consumed in 5, 6, and 10. `DatabaseConnectionStore` gains four methods in Task 5 and is consumed in 6 and 8. `DbConnectionRow` is defined in Task 3 and mirrored in the web types in Task 9 — the web copy omits `userId`, which the API never serialises.

**Known deviation:** `runReadOnly` issues `BEGIN` / query / `ROLLBACK` as separate statements against a single-connection pool rather than using `Bun.SQL`'s `begin()` helper, because the helper commits on success and there is no clean way to force a rollback without throwing a sentinel. Task 10 Step 2 verifies this holds against a real server; if `max: 1` ever changes, the guarantee breaks silently.
