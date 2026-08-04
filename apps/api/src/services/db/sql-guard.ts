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
