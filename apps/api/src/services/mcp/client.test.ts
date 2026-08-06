import { describe, expect, it } from "bun:test";
import {
  CONNECT_TIMEOUT_MS,
  STDIO_CONNECT_TIMEOUT_MS,
  connectMcpServer,
  connectTimeoutFor,
} from "./client";

describe("connectTimeoutFor", () => {
  it("gives stdio a much longer budget than http", () => {
    // The first connection to a new stdio server is a package download, not a
    // handshake. Sharing http's budget made every newly added server fail once
    // and succeed on retry.
    expect(connectTimeoutFor("stdio")).toBe(STDIO_CONNECT_TIMEOUT_MS);
    expect(connectTimeoutFor("http")).toBe(CONNECT_TIMEOUT_MS);
    expect(connectTimeoutFor("stdio")).toBeGreaterThan(connectTimeoutFor("http"));
  });
});

describe("connectMcpServer", () => {
  it("refuses a stdio command that is not on the allowlist", async () => {
    await expect(
      connectMcpServer({ id: "s1", name: "evil", transport: "stdio", command: "sh", args: ["-c", "id"] }),
    ).rejects.toThrow(/not allowed/);
  });

  it("refuses an interpreter asked to evaluate inline code", async () => {
    await expect(
      connectMcpServer({ id: "s2", name: "evil", transport: "stdio", command: "node", args: ["-e", "1"] }),
    ).rejects.toThrow(/inline code/);
  });

  it("gives up on an unreachable http server within its budget", async () => {
    // Port 9 is discard: it refuses fast, so this asserts the failure path
    // without waiting out a real timeout.
    await expect(
      connectMcpServer(
        { id: "s3", name: "down", transport: "http", url: "http://127.0.0.1:9/mcp" },
        1_000,
      ),
    ).rejects.toThrow();
  }, 15_000);
});
