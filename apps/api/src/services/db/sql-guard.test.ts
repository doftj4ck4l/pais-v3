/**
 * Tests for the read-only SQL statement guard.
 *
 * This guard is tested exhaustively because it is the layer that produces the
 * agent's error message. A false rejection silently blocks a legitimate query,
 * while a false acceptance is caught only by the READ ONLY transaction layer
 * behind it — so correctness here is critical to the agent's experience.
 */

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
  ["an E-string with backslash escape", "SELECT E'line\\nbreak' FROM logs"],
  ["ordinary doubled-quote escape", "SELECT 'it''s fine' FROM t"],
  ["ordinary string with trailing backslash", "SELECT 'a\\' FROM t"],
  ["dollar-quoted string", "SELECT $$dollar quoted$$ AS x"],
  ["dollar-quoted string with tag", "SELECT $tag$body$tag$ AS x"],
  ["quoted identifiers with keywords", 'SELECT "close", "update" FROM prices'],
  ["nested block comments", "SELECT 1 /* outer /* nested */ still comment */"],
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
  ["E-string with backslash hiding stacked statement", "SELECT E'\\'' ; SET statement_timeout = 1 --'"],
  ["E-string with backslash hiding DROP", "SELECT E'\\'' ; DROP TABLE orders --'"],
  ["unterminated single-quoted string", "SELECT 'unterminated"],
  ["unterminated block comment", "SELECT 1 /* unterminated"],
  ["unterminated dollar-quoted string", "SELECT $$unterminated"],
  ["quoted identifier with semicolon outside", 'SELECT "close" ; DROP TABLE t'],
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
