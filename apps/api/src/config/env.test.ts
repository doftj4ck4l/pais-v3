import { describe, expect, it } from "bun:test";
import { parseOrganizationInviteTtlMs, parsePublicUrl } from "./env";

describe("organization environment configuration", () => {
  it("accepts only a clean http(s) public origin", () => {
    expect(parsePublicUrl("https://salur.example/")).toBe("https://salur.example");
    expect(() => parsePublicUrl("https://user:secret@salur.example")).toThrow();
    expect(() => parsePublicUrl("https://salur.example/subpath")).toThrow();
    expect(() => parsePublicUrl("not a URL")).toThrow();
  });

  it("uses a seven-day TTL and bounds explicit whole-hour values", () => {
    expect(parseOrganizationInviteTtlMs(undefined)).toBe(168 * 60 * 60 * 1000);
    expect(parseOrganizationInviteTtlMs("24")).toBe(24 * 60 * 60 * 1000);
    expect(() => parseOrganizationInviteTtlMs("0")).toThrow();
    expect(() => parseOrganizationInviteTtlMs("1.5")).toThrow();
  });
});
