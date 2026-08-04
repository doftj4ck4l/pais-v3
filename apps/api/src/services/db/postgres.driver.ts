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

/**
 * Serialized bytes of row data returned to the model in one query, independent
 * of ROW_CAP. A handful of rows with a wide text/json/bytea column can blow the
 * model's context long before 100 rows accumulate, so this is a second,
 * orthogonal cap — not a derivation of the row cap.
 */
export const BYTE_CAP = 50_000;

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
  | {
      ok: true;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
      /**
       * Which budget cut the result short, so the tool layer can give advice
       * that matches the actual problem: too many rows means aggregate in
       * SQL; too many bytes means select fewer columns or use `left(col, n)`.
       * `null` when `truncated` is false. When both budgets would have fired,
       * `"bytes"` wins — it is the one that actually determined how many of
       * the row-capped rows made it into `rows`.
       *
       * Optional (not just nullable) so an outcome built by hand — an older
       * test, or a future executor — remains a valid `QueryOutcome` without
       * this field; the tool layer treats a missing reason the same as
       * `"rows"`, its behavior before this field existed.
       */
      truncatedReason?: "rows" | "bytes" | null;
    }
  | { ok: false; error: string };

/**
 * `max: 1` is load-bearing everywhere below: `runReadOnly` issues BEGIN, the
 * query, and ROLLBACK as separate statements, which are only guaranteed to land
 * on the same backend when the pool holds exactly one connection.
 *
 * `idleTimeout` must stay comfortably above `STATEMENT_TIMEOUT_MS`, not equal
 * to it: the two are a race, and the server's `statement_timeout` has to win
 * it deterministically. It is the layer that also bounds a query the client
 * would otherwise happily wait on — a client-side idle timeout firing first
 * would cut the connection without ever proving the server-side budget works,
 * and on a slow or congested network the race could go either way run to run.
 */
function client(url: string): any {
  return new Bun.SQL({ url, max: 1, idleTimeout: 30, connectionTimeout: 10 });
}

/**
 * Never let a driver error carry the credential into a log or a tool result.
 *
 * Two things make this harder than a single string replace:
 *
 * - `URL.password` is percent-encoded (WHATWG URL semantics), but a driver
 *   error may quote the connection string with the password decoded — a
 *   generated password containing `@`, `%`, `#`, or `/` will not match the
 *   encoded form. Both forms are scrubbed.
 * - A malformed URL can still carry credentials verbatim in its text (it
 *   just doesn't parse). Falling back to silence would leak them, so the
 *   catch branch strips any userinfo-shaped segment instead.
 * - A Postgres URI can also carry the password as a `?password=...` query
 *   parameter (`Bun.SQL` honours it — confirmed live: a URL with a bogus
 *   userinfo password but a correct `?password=` connects). Destinations are
 *   the server log and the browser tooltip, same as the userinfo password,
 *   so it is scrubbed the same way — encoded and decoded form both.
 *
 * Exported (not just used internally) so `db-tools.ts` can apply it again to
 * `outcome.error` before rendering: `runReadOnly`'s own callers are expected
 * to pass already-scrubbed errors, but the tool layer sits directly in front
 * of the model and "the model must never see a connection string" cannot
 * depend on every current and future executor implementation getting this
 * right upstream.
 */
export function scrub(message: string, url: string): string {
  let out = message;
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      out = out.split(parsed.password).join("***");
      try {
        const decoded = decodeURIComponent(parsed.password);
        if (decoded && decoded !== parsed.password) out = out.split(decoded).join("***");
      } catch {
        // A malformed percent-escape must not throw inside an error handler.
      }
    }
    // `URLSearchParams.get` returns the DECODED value — the mirror image of
    // `URL.password`, which is encoded. So the raw (possibly still-encoded)
    // form has to come from the query string text itself, not from the
    // parsed API, or a password containing `%`, `+`, or `&`-adjacent bytes
    // would only get scrubbed in one of its two possible on-the-wire forms.
    const rawQueryMatch = /[?&]password=([^&]*)/.exec(parsed.search);
    const rawQueryPassword = rawQueryMatch?.[1];
    if (rawQueryPassword) {
      out = out.split(rawQueryPassword).join("***");
      try {
        const decoded = decodeURIComponent(rawQueryPassword);
        if (decoded && decoded !== rawQueryPassword) out = out.split(decoded).join("***");
      } catch {
        // A malformed percent-escape must not throw inside an error handler.
      }
    }
  } catch {
    // Fail safe, not silent: strip any "//user:pass@" userinfo segment even
    // though the URL itself didn't parse.
    out = out.replace(/\/\/[^/@\s]*@/g, "//***@");
  }
  return out;
}

/**
 * Coerce and clamp the caller-supplied cap. The only invariant that matters:
 * for every input — negative, zero, fractional, NaN, Infinity, or absurdly
 * large — the result can only ever LOWER ROW_CAP, never raise it.
 */
function boundCap(cap: number): number {
  const finite = Number.isFinite(cap) ? Math.floor(cap) : ROW_CAP;
  return Math.max(1, Math.min(ROW_CAP, finite));
}

/**
 * `JSON.stringify` throws on a `bigint` (a real value for a Postgres `bigint`
 * column), which would turn a byte-budget check into a 500 on exactly the
 * wide-row queries this budget exists to catch. This is only used to size a
 * row for the budget, not to build what is sent to the model.
 */
function serializeForSize(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
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

  // Constructed inside the try: `new Bun.SQL(...)` can throw synchronously on
  // a malformed connection string, and that error must be scrubbed too.
  let sql: any;
  try {
    sql = client(url);
    await sql`SELECT 1`;
    return {
      ok: true,
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, "") || "postgres",
    };
  } catch (e: any) {
    return { ok: false, error: scrub(e?.message ?? String(e), url) };
  } finally {
    if (sql) await sql.close().catch(() => {});
  }
}

export async function fetchCatalog(url: string): Promise<RawCatalog> {
  // Constructed inside the try: see `probe` for why.
  let sql: any;
  try {
    sql = client(url);
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
        AND schemaname NOT LIKE 'pg_toast%'
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
    if (sql) await sql.close().catch(() => {});
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
 * `guardReadOnly` returns the statement with comments intact, so the closing
 * paren and LIMIT go on their own line — otherwise a trailing `-- comment` in
 * agent-written SQL (routine in LLM output) would comment out both.
 */
export async function runReadOnly(
  url: string,
  rawSql: string,
  cap: number = ROW_CAP,
): Promise<QueryOutcome> {
  const guarded = guardReadOnly(rawSql);
  if (!guarded.ok) return { ok: false, error: guarded.reason };

  const bounded = boundCap(cap);
  // `isExplain` is a fact the guard already decided against the blanked
  // (comment/literal-free) text — re-deriving it here from `guarded.sql`
  // (raw text) is exactly the bug this fix removes: a leading block comment
  // before EXPLAIN reads as "not EXPLAIN" to a regex over raw text.
  const isExplain = guarded.isExplain;
  const statement = isExplain
    ? guarded.sql
    : `SELECT * FROM (\n${guarded.sql}\n) AS _capped LIMIT ${bounded + 1}`;

  // Constructed inside the try: see `probe` for why.
  let sql: any;
  let inTransaction = false;
  try {
    sql = client(url);
    await sql.unsafe("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    await sql.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    const rows: Record<string, unknown>[] = await sql.unsafe(statement);
    const rowCapped = !isExplain && rows.length > bounded;
    const rowLimited = rowCapped ? rows.slice(0, bounded) : rows;

    // Byte budget applies AFTER the row cap (so a query already trimmed to
    // `bounded` rows is what gets measured) but is not exempt for EXPLAIN —
    // an EXPLAIN plan is itself unbounded and can be large. At least one row
    // is always kept even if it alone exceeds the budget: a single-row,
    // single-column result cannot be partially truncated, so it is returned
    // whole with `truncated: true` rather than dropped entirely.
    let bytes = 0;
    let byteCapped = false;
    const shown: Record<string, unknown>[] = [];
    for (const row of rowLimited) {
      const size = Buffer.byteLength(serializeForSize(row));
      if (shown.length > 0 && bytes + size > BYTE_CAP) {
        byteCapped = true;
        break;
      }
      shown.push(row);
      bytes += size;
      if (bytes > BYTE_CAP) {
        byteCapped = true;
        break;
      }
    }

    const truncated = rowCapped || byteCapped;
    const truncatedReason: "rows" | "bytes" | null = byteCapped ? "bytes" : rowCapped ? "rows" : null;

    return {
      ok: true,
      columns: shown.length ? Object.keys(shown[0]!) : [],
      rows: shown,
      truncated,
      truncatedReason,
    };
  } catch (e: any) {
    return { ok: false, error: scrub(e?.message ?? String(e), url) };
  } finally {
    if (inTransaction) await sql.unsafe("ROLLBACK").catch(() => {});
    if (sql) await sql.close().catch(() => {});
  }
}
