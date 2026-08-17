import { describe, expect, it } from "bun:test";
import type { DatabaseConnectionConfig } from "./database-adapter";
import { boundCap, guardPostgresqlFunctions, postgresqlAdapter } from "./postgres.driver";
import { DATABASE_ROW_CAP as ROW_CAP } from "./query-policy";

/**
 * `boundCap` is the single authority on what a caller-supplied row limit is
 * allowed to mean (see the comment on `run_query` in db-tools.ts, which
 * deliberately no longer clamps before calling the driver). The one
 * invariant that matters — for every input, however malformed — is that the
 * result can only ever lower ROW_CAP, never raise it, and is always a whole
 * number of at least one row. Nothing else in the test suite exercises this
 * function directly, so a regression here (e.g. a caller sneaking a value
 * above ROW_CAP or below 1 past the clamp) would otherwise only surface as a
 * live-database row-count mismatch.
 */
describe("boundCap", () => {
  const cases: [string, number | undefined][] = [
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-5", -5],
    ["0", 0],
    ["5.7", 5.7],
    ["100", 100],
    ["1000", 1000],
    ["1e9", 1e9],
  ];

  for (const [label, input] of cases) {
    it(`clamps ${label} to an integer in [1, ${ROW_CAP}]`, () => {
      const result = boundCap(input as number);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(ROW_CAP);
    });
  }
});

const config: DatabaseConnectionConfig = {
  engine: "postgresql",
  host: "10.35.180.238",
  port: 5432,
  database: "takaful",
  username: "reader",
  password: "secret",
  ssl: { mode: "disable" },
};
const target = { originalHost: config.host, address: config.host, family: 4 as const };

describe("PostgreSQL adapter", () => {
  it("declares the capabilities future drivers may differ on", () => {
    expect(postgresqlAdapter.engine).toBe("postgresql");
    expect(postgresqlAdapter.capabilities).toMatchObject({
      schemas: true,
      explain: true,
      readOnlyTransactions: true,
      statementTimeout: true,
    });
  });

  for (const sql of [
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT dblink('host=10.0.0.2', 'SELECT 1')",
    "SELECT pg_advisory_lock(1)",
    "SELECT nextval('orders_id_seq')",
    "SELECT \"pg_read_file\"('/etc/passwd')",
    `SELECT U&"pg\\005fread\\005ffile"('/etc/passwd')`,
  ]) {
    it(`rejects unsafe PostgreSQL function: ${sql.split("(")[0]}`, async () => {
      const result = await postgresqlAdapter.executeReadOnly(config, target, sql);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("query_rejected");
    });
  }

  it("does not mistake an unsafe function name inside a string for a call", async () => {
    expect(guardPostgresqlFunctions("SELECT 'pg_read_file(' AS harmless")).toBeNull();
  });
});
