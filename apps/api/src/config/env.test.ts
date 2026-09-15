import { describe, expect, it } from "bun:test";
import {
  parseAgentInvocationTimeoutMs,
  parseAuthMode,
  parseDocumentUploadMaxBytes,
  parseLocalSessionTtlMs,
  parseOrganizationInviteTtlMs,
  parsePublicUrl,
} from "./env";

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

  it("bounds the public agent provider timeout", () => {
    expect(parseAgentInvocationTimeoutMs(undefined)).toBe(180_000);
    expect(parseAgentInvocationTimeoutMs("30000")).toBe(30_000);
    expect(() => parseAgentInvocationTimeoutMs("999")).toThrow();
    expect(() => parseAgentInvocationTimeoutMs("300001")).toThrow();
    expect(() => parseAgentInvocationTimeoutMs("1.5")).toThrow();
  });

  it("defaults and bounds the document upload limit", () => {
    expect(parseDocumentUploadMaxBytes(undefined)).toBe(25 * 1024 * 1024);
    expect(parseDocumentUploadMaxBytes(String(200 * 1024 * 1024))).toBe(200 * 1024 * 1024);
    expect(() => parseDocumentUploadMaxBytes("1048575")).toThrow();
    expect(() => parseDocumentUploadMaxBytes(String(513 * 1024 * 1024))).toThrow();
    expect(() => parseDocumentUploadMaxBytes("1.5")).toThrow();
  });

  it("accepts the three explicit authentication modes", () => {
    expect(parseAuthMode(undefined)).toBe("proxy");
    expect(parseAuthMode("local")).toBe("local");
    expect(parseAuthMode("dev")).toBe("dev");
    expect(() => parseAuthMode("basic")).toThrow();
  });

  it("bounds local browser sessions", () => {
    expect(parseLocalSessionTtlMs(undefined)).toBe(168 * 60 * 60 * 1000);
    expect(parseLocalSessionTtlMs("24")).toBe(24 * 60 * 60 * 1000);
    expect(() => parseLocalSessionTtlMs("0")).toThrow();
    expect(() => parseLocalSessionTtlMs("721")).toThrow();
  });
});
