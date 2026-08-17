import { describe, expect, it } from "bun:test";
import { HARNESSES, getHarness } from "./harnesses";

describe("agent harness catalog", () => {
  it("exposes one unified harness", () => {
    expect(HARNESSES.map((h) => h.id)).toEqual(["pi"]);
    expect(getHarness("pi")).toBe(HARNESSES[0]);
    // Existing conversations may still carry the retired id. They must remain
    // resumable even though new sessions no longer offer a harness choice.
    expect(getHarness("db-analyst")).toBe(HARNESSES[0]);
  });
});
