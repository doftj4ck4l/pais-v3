import { describe, expect, it } from "bun:test";
import { isSuperAdmin, normalizeEmail, parseSuperAdminEmails } from "./policy";

describe("organization administration policy", () => {
  it("normalizes configured and authenticated emails case-insensitively", () => {
    const allowed = parseSuperAdminEmails(" Admin@Example.com, other@example.com ");
    expect(allowed).toEqual(["admin@example.com", "other@example.com"]);
    expect(isSuperAdmin(" ADMIN@example.com ", allowed)).toBe(true);
  });

  it("fails closed without both a caller email and configured allowlist", () => {
    expect(isSuperAdmin(undefined, ["admin@example.com"])).toBe(false);
    expect(isSuperAdmin("admin@example.com", [])).toBe(false);
    expect(isSuperAdmin("other@example.com", ["admin@example.com"])).toBe(false);
  });

  it("rejects malformed recipient emails", () => {
    expect(normalizeEmail(" Person@Example.COM ")).toBe("person@example.com");
    expect(() => normalizeEmail("not an email")).toThrow("valid email");
  });
});
