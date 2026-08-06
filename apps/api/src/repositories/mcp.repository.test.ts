import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import {
  DuplicateServerNameError,
  SqliteMcpStore,
  type NewMcpServer,
} from "./mcp.repository";

/**
 * Runs against a real in-memory database built from the production schema, for
 * the same reason the database-connection tests do: the unique-name index, the
 * capability cascade, and the encrypt/decrypt round trip are the parts most
 * likely to be wrong, and a mock would assert none of them.
 */

(env as { connectionSecret: string }).connectionSecret = "test-secret";

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteMcpStore(drizzle(sqlite) as any);
}

const http = (over: Partial<NewMcpServer> = {}): NewMcpServer => ({
  id: "s1",
  workspaceId: "ws1",
  name: "github",
  transport: "http",
  url: "https://mcp.example.com/sse",
  headers: { Authorization: "Bearer ghp_supersecret" },
  ...over,
});

const stdio = (over: Partial<NewMcpServer> = {}): NewMcpServer => ({
  id: "s2",
  workspaceId: "ws1",
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  env: { API_KEY: "sk_verysecret" },
  ...over,
});

let store: SqliteMcpStore;
beforeEach(() => {
  store = freshStore();
});

describe("SqliteMcpStore", () => {
  it("stores an http server and lists it back without the headers", async () => {
    await store.create(http());
    const rows = await store.list("ws1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("github");
    expect(rows[0]!.transport).toBe("http");
    expect(rows[0]!.url).toBe("https://mcp.example.com/sse");
    expect(JSON.stringify(rows[0])).not.toContain("ghp_supersecret");
  });

  it("stores a stdio server and lists it back without the env", async () => {
    await store.create(stdio());
    const rows = await store.list("ws1");
    expect(rows[0]!.command).toBe("npx");
    expect(JSON.parse(rows[0]!.argsJson!)).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(JSON.stringify(rows[0])).not.toContain("sk_verysecret");
  });

  it("does not store header or env secrets in plaintext", async () => {
    await store.create(http());
    await store.create(stdio());
    const raw1 = await store.debugRawSecrets("s1");
    const raw2 = await store.debugRawSecrets("s2");
    expect(raw1.headersEnc).not.toContain("ghp_supersecret");
    expect(raw1.headersEnc?.startsWith("v1.")).toBe(true);
    expect(raw2.envEnc).not.toContain("sk_verysecret");
    expect(raw2.envEnc?.startsWith("v1.")).toBe(true);
  });

  it("omits the secret columns entirely from list output", async () => {
    await store.create(http());
    const [row] = await store.list("ws1");
    expect(row).not.toHaveProperty("headersEnc");
    expect(row).not.toHaveProperty("envEnc");
  });

  it("resolves decrypted secrets for the owning workspace", async () => {
    await store.create(http());
    const secrets = await store.resolveSecrets("ws1", "s1");
    expect(secrets!.headers).toEqual({ Authorization: "Bearer ghp_supersecret" });
    expect(secrets!.env).toEqual({});
  });

  it("refuses to resolve secrets for another workspace", async () => {
    await store.create(http());
    expect(await store.resolveSecrets("ws2", "s1")).toBeNull();
  });

  it("scopes listing by workspace", async () => {
    await store.create(http());
    await store.create(http({ id: "s9", workspaceId: "ws2", name: "github" }));
    expect(await store.list("ws1")).toHaveLength(1);
    expect(await store.list("ws2")).toHaveLength(1);
  });

  it("rejects a duplicate name inside one workspace", async () => {
    await store.create(http());
    await expect(store.create(http({ id: "s3" }))).rejects.toBeInstanceOf(
      DuplicateServerNameError,
    );
  });

  it("finds a server by name", async () => {
    await store.create(http());
    expect((await store.findByName("ws1", "github"))!.id).toBe("s1");
    expect(await store.findByName("ws1", "gitlab")).toBeNull();
  });

  it("lists only enabled servers for a run", async () => {
    await store.create(http());
    await store.create(stdio());
    await store.setEnabled("ws1", "s2", false);
    const enabled = await store.listEnabled("ws1");
    expect(enabled.map((s) => s.name)).toEqual(["github"]);
  });

  it("records probe status and error", async () => {
    await store.create(http());
    await store.markStatus("ws1", "s1", "error", "connect ECONNREFUSED");
    const [row] = await store.list("ws1");
    expect(row!.status).toBe("error");
    expect(row!.error).toBe("connect ECONNREFUSED");
  });

  it("saves capabilities and reports the tool count", async () => {
    await store.create(http());
    await store.saveCapabilities("ws1", "s1", [
      { kind: "tool", name: "search", description: "Search issues", schemaJson: "{}" },
      { kind: "tool", name: "create_issue", description: null, schemaJson: "{}" },
      { kind: "resource", name: "readme", description: null, uri: "repo://readme" },
      { kind: "prompt", name: "triage", description: "Triage a bug", schemaJson: "[]" },
    ]);
    const caps = await store.capabilities("ws1", "s1");
    expect(caps).toHaveLength(4);
    const [row] = await store.list("ws1");
    expect(row!.toolCount).toBe(2);
    expect(row!.lastProbedAt).toBeGreaterThan(0);
  });

  it("replaces capabilities on re-probe rather than accumulating them", async () => {
    await store.create(http());
    await store.saveCapabilities("ws1", "s1", [
      { kind: "tool", name: "search", description: null, schemaJson: "{}" },
    ]);
    await store.saveCapabilities("ws1", "s1", [
      { kind: "tool", name: "search_v2", description: null, schemaJson: "{}" },
    ]);
    const caps = await store.capabilities("ws1", "s1");
    expect(caps.map((c) => c.name)).toEqual(["search_v2"]);
  });

  it("returns an inventory of enabled servers and their tools", async () => {
    await store.create(http());
    await store.create(stdio());
    await store.saveCapabilities("ws1", "s1", [
      { kind: "tool", name: "search", description: "Search issues", schemaJson: "{}" },
    ]);
    await store.saveCapabilities("ws1", "s2", [
      { kind: "tool", name: "read_file", description: null, schemaJson: "{}" },
    ]);
    await store.setEnabled("ws1", "s2", false);

    const inventory = await store.inventory("ws1");
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.name).toBe("github");
    expect(inventory[0]!.tools).toEqual([{ name: "search", description: "Search issues" }]);
  });

  it("removes a server and its cached capabilities", async () => {
    await store.create(http());
    await store.saveCapabilities("ws1", "s1", [
      { kind: "tool", name: "search", description: null, schemaJson: "{}" },
    ]);
    expect(await store.remove("ws1", "s1")).toBe(true);
    expect(await store.list("ws1")).toHaveLength(0);
    expect(await store.capabilities("ws1", "s1")).toHaveLength(0);
  });

  it("refuses to remove another workspace's server", async () => {
    await store.create(http());
    expect(await store.remove("ws2", "s1")).toBe(false);
    expect(await store.list("ws1")).toHaveLength(1);
  });
});
