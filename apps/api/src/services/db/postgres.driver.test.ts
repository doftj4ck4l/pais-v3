import { describe, expect, it } from "bun:test";
import { boundCap, ROW_CAP } from "./postgres.driver";

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
