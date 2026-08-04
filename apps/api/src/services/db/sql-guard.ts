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

export type GuardResult =
  | {
      ok: true;
      sql: string;
      /**
       * Decided here, against the blanked (comment/literal-free) text, and
       * must be consumed as-is by the driver rather than re-derived from
       * `sql`: `sql` can start with a leading block comment, e.g. a "plan"
       * note before an EXPLAIN, which makes a naive `/^\s*explain\b/`
       * re-check on raw text miss it.
       */
      isExplain: boolean;
    }
  | { ok: false; reason: string };

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
 *
 * Returns { blanked, ok } where ok is false if any literal or comment is
 * unterminated. Fail closed: incomplete strings reject the statement.
 */
function blankLiteralsAndComments(sql: string): { blanked: string; ok: boolean } {
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
      if (depth > 0) {
        // Unterminated block comment
        return { blanked: out.join(""), ok: false };
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      // Check if this is an E-string (E or e immediately before the quote, with word boundary).
      let isEString = false;
      let startIndex = i;
      if (i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e')) {
        // Word boundary check: position i-2 should not be a word character.
        if (i - 2 < 0 || !/\w/.test(sql[i - 2])) {
          isEString = true;
          startIndex = i - 1; // Include the E in the blanked region.
        }
      }

      let j = i + 1;
      let terminated = false;
      while (j < sql.length) {
        if (isEString && sql[j] === '\\' && j + 1 < sql.length) {
          // In E-strings, backslash escapes the next character.
          j += 2;
          continue;
        }
        if (sql[j] === "'" && j + 1 < sql.length && sql[j + 1] === "'") {
          // '' escape (works in both ordinary and E-strings).
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++; // Include the closing quote.
          terminated = true;
          break;
        }
        j++;
      }

      if (!terminated) {
        // Unterminated string literal.
        return { blanked: out.join(""), ok: false };
      }

      blank(startIndex, j);
      i = j;
      continue;
    }

    if (sql[i] === '"') {
      // Quoted identifier: not a literal, but its contents must not be scanned
      // for keywords either — a column may legitimately be named "update".
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      if (j >= sql.length) {
        // Unterminated quoted identifier.
        return { blanked: out.join(""), ok: false };
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }

    if (sql[i] === "$") {
      // Dollar-quoted string: $tag$ ... $tag$
      // Tag can be empty ($$) or start with letter/underscore followed by digits/letters/underscores.
      // Tag cannot start with a digit if it has characters.
      const match = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          // Unterminated dollar-quoted string.
          return { blanked: out.join(""), ok: false };
        }
        const stop = end + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i++;
  }

  return { blanked: out.join(""), ok: true };
}

export function guardReadOnly(raw: string): GuardResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty statement" };

  const { blanked, ok: blankOk } = blankLiteralsAndComments(trimmed);
  if (!blankOk) {
    return { ok: false, reason: "statement contains unterminated string or comment" };
  }

  const scan = blanked.trim();

  // One statement only. A trailing semicolon is fine, whether or not a
  // comment follows it — blanking has already turned a trailing comment into
  // plain whitespace, so `;\s*$` matches straight through it. This is the fix
  // for `SELECT 1 AS one; -- note`: matching that pattern against RAW text
  // (the previous bug) fails, because the comment after the `;` is
  // non-whitespace there, so the trailing `;` reads as "more statement
  // follows" and the caller wraps (and breaks) an ordinary trailing comment.
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

  const isExplain = /^explain\b/i.test(withoutTrailing);

  if (isExplain && /\banalyze\b/i.test(withoutTrailing)) {
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

  // Reconstruct the RAW statement — preserving string literals, which
  // `blanked` destroyed — with the trailing `;` and anything after it
  // (comment or otherwise) removed. `blanked` is exactly as long as
  // `trimmed` and position-for-position aligned with it (blanking replaces
  // characters in place, it never deletes), so the cut point found via the
  // same `;\s*$` match against the UNTRIMMED `blanked` is valid to apply to
  // `trimmed` directly, regardless of what a leading comment did to `scan`.
  const blankedWithoutTrailing = blanked.replace(/;\s*$/, "");
  const sql = trimmed.slice(0, blankedWithoutTrailing.length).trimEnd();

  return { ok: true, sql, isExplain };
}
