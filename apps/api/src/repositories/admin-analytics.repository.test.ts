import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { adminAnalyticsRepository } from "./admin-analytics.repository";

let sqlite: Database;
let database: any;

const DAY = 86_400_000;
const now = Date.UTC(2026, 7, 18, 12);

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  database = drizzle(sqlite) as any;

  const insertUser = sqlite.query("insert into users (id, created_at, display_name) values (?, ?, ?)");
  insertUser.run("alice", now - 40 * DAY, "Alice");
  insertUser.run("bob", now - 20 * DAY, null);
  insertUser.run("quiet", now - 10 * DAY, "Quiet User");

  const insertWorkspace = sqlite.query("insert into workspaces (id, user_id, name, created_at) values (?, ?, ?, ?)");
  insertWorkspace.run("wa", "alice", "Alpha", now - 30 * DAY);
  insertWorkspace.run("wb", "bob", "Beta", now - 15 * DAY);
  insertWorkspace.run("wq", "quiet", "Quiet", now - 5 * DAY);

  sqlite.query("insert into organizations (id, name, created_by_user_id, created_at, updated_at) values (?, ?, ?, ?, ?)")
    .run("org1", "Acme", "alice", now - 20 * DAY, now - 20 * DAY);
  sqlite.query("insert into organization_memberships (id, organization_id, user_id, email, joined_at) values (?, ?, ?, ?, ?)")
    .run("mem1", "org1", "alice", "alice@example.com", now - 19 * DAY);

  const insertConversation = sqlite.query(
    "insert into conversations (id, workspace_id, title, model_id, harness_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertConversation.run("ca", "wa", "Plan launch", "gw-fast", "pi", "done", now - DAY, now - DAY);
  insertConversation.run("cb", "wb", "Summarise notes", "gw-smart", "pi", "error", now - 2 * DAY, now - 2 * DAY);

  const insertRun = sqlite.query(
    "insert into runs (id, conversation_id, workspace_id, harness_id, model_id, prompt, started_at, ended_at, status, turns, tokens_in, tokens_out, tool_calls, tool_errors) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertRun.run("ra", "ca", "wa", "pi", "gw-fast", "Plan launch", now - DAY, now - DAY + 1000, "done", 2, 100, 25, 3, 0);
  insertRun.run("rb", "cb", "wb", "pi", "gw-smart", "Summarise notes", now - 2 * DAY, now - 2 * DAY + 500, "error", 1, 70, 5, 2, 1);
});

describe("adminAnalyticsRepository", () => {
  it("summarises platform activity across every user and workspace", async () => {
    const result = await adminAnalyticsRepository.overview(30, now, database);

    expect(result.totals).toEqual({
      users: 3,
      workspaces: 3,
      organizations: 1,
      conversations: 2,
      runs: 2,
      tokensIn: 170,
      tokensOut: 30,
      toolCalls: 5,
      toolErrors: 1,
    });
    expect(result.period).toMatchObject({ runs: 2, conversations: 2, activeUsers: 2, tokensIn: 170, tokensOut: 30, errors: 1 });
    expect(result.models).toEqual([
      { modelId: "gw-fast", runs: 1, tokensIn: 100, tokensOut: 25 },
      { modelId: "gw-smart", runs: 1, tokensIn: 70, tokensOut: 5 },
    ]);
    expect(result.daily).toHaveLength(30);
    expect(result.daily.reduce((sum, day) => sum + day.runs, 0)).toBe(2);
  });

  it("lists active and independent users without hiding users that have no runs", async () => {
    const result = await adminAnalyticsRepository.listUsers({ limit: 20, offset: 0, query: "" }, database);

    expect(result.total).toBe(3);
    expect(result.users.map((user) => user.userId)).toEqual(["alice", "bob", "quiet"]);
    expect(result.users[0]).toMatchObject({
      userId: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      workspaceCount: 1,
      conversationCount: 1,
      runCount: 1,
      tokensIn: 100,
      tokensOut: 25,
      organizations: [{ id: "org1", name: "Acme" }],
    });
    expect(result.users.find((user) => user.userId === "bob")?.organizations).toEqual([]);
    expect(result.users.find((user) => user.userId === "quiet")).toMatchObject({ runCount: 0, lastActiveAt: null });
  });

  it("searches users by identity and organization", async () => {
    const byEmail = await adminAnalyticsRepository.listUsers({ limit: 20, offset: 0, query: "alice@example" }, database);
    expect(byEmail.users.map((user) => user.userId)).toEqual(["alice"]);
    expect(byEmail.total).toBe(1);

    const byOrg = await adminAnalyticsRepository.listUsers({ limit: 20, offset: 0, query: "acme" }, database);
    expect(byOrg.users.map((user) => user.userId)).toEqual(["alice"]);
    expect(byOrg.total).toBe(1);
  });

  it("returns the exact filtered total when the requested page is empty", async () => {
    const result = await adminAnalyticsRepository.listUsers({ limit: 1, offset: 1, query: "acme" }, database);

    expect(result.users).toEqual([]);
    expect(result.total).toBe(1);
  });
});
