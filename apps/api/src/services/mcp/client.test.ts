import { describe, expect, it } from "bun:test";
import {
  CONNECT_TIMEOUT_MS,
  STDIO_CONNECT_TIMEOUT_MS,
  connectMcpServer,
  connectTimeoutFor,
  McpConnectError,
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

describe("stdio failure diagnostics", () => {
  /**
   * The regression this guards is a one-word deletion away: `stderr: "pipe"`
   * was already set, but nothing read the pipe, so a launcher that died during
   * startup reported only the transport error that followed. "Connection
   * closed" is a symptom; the cause was being thrown away.
   *
   * `bun` is the launcher under test because the suite is already running
   * under it — no package download, no network, and it is on the allowlist.
   */
  it("attaches what the process said on the way down", async () => {
    let thrown: unknown;
    try {
      await connectMcpServer(
        {
          id: "t1",
          name: "broken",
          transport: "stdio",
          command: "bun",
          args: ["run", "definitely-not-a-real-script-xyz"],
          env: {},
        },
        20_000,
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(McpConnectError);
    const error = thrown as McpConnectError;
    // The summary alone is the unhelpful message users were left with.
    expect(error.message).toContain("Connection closed");
    // The detail is the part that makes it actionable.
    expect(error.detail).toContain("definitely-not-a-real-script-xyz");
  }, 30_000);

  it("does not invent a detail when the command never starts", async () => {
    let thrown: unknown;
    try {
      await connectMcpServer(
        {
          id: "t2",
          name: "nope",
          transport: "stdio",
          // Rejected by the allowlist before anything is spawned, so there is
          // no process and therefore nothing to attach.
          command: "definitely-not-allowed",
          args: [],
          env: {},
        },
        5_000,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(McpConnectError);
  });
});
