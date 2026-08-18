import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";

let dir: string;
let createApp: typeof import("./app").createApp;
let database: typeof import("./db/client").db;
let workspaceTable: typeof import("./db/client").workspaces;

const jsonHeaders = (id: string, email: string) => ({
  "x-authentik-uid": id,
  "x-authentik-email": email,
  "content-type": "application/json",
});
const admin = jsonHeaders("admin-uid", "admin@example.com");
const invitee = jsonHeaders("person-uid", "person@example.com");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-organizations-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  const client = await import("./db/client");
  client.ensureSchema();
  database = client.db;
  workspaceTable = client.workspaces;
  const { env } = await import("./config/env");
  (env as unknown as { superAdminEmails: string[] }).superAdminEmails = ["admin@example.com"];
  ({ createApp } = await import("./app"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const requestJson = (url: string, method: string, headers: Record<string, string>, body?: unknown) =>
  createApp().request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("organization administration HTTP API", () => {
  it("rejects organization management for a non-super-admin", async () => {
    const res = await createApp().request("/api/admin/organizations", {
      headers: jsonHeaders("other", "other@example.com"),
    });
    expect(res.status).toBe(403);
  });

  it("protects platform analytics, users, and runs with the same super-admin policy", async () => {
    const headers = jsonHeaders("other", "other@example.com");
    for (const path of [
      "/api/admin/analytics",
      "/api/admin/users",
      "/api/admin/runs",
      "/api/admin/runs/missing",
    ]) {
      expect((await createApp().request(path, { headers })).status).toBe(403);
    }
  });

  it("serves platform analytics and users to a super-admin", async () => {
    const analytics = await createApp().request("/api/admin/analytics?days=14", { headers: admin });
    expect(analytics.status).toBe(200);
    expect(await analytics.json()).toMatchObject({ periodDays: 14, totals: { users: expect.any(Number) } });

    const users = await createApp().request("/api/admin/users?limit=25", { headers: admin });
    expect(users.status).toBe(200);
    expect(await users.json()).toMatchObject({ users: expect.any(Array), total: expect.any(Number) });
  });

  it("serves filtered cross-tenant runs and positioned spans to a super-admin", async () => {
    const startedAt = Date.UTC(2026, 7, 18, 12);
    await database.run(sql`
      INSERT INTO users (id, display_name, created_at)
      VALUES ('http-user', 'HTTP User', ${startedAt - 1_000})
    `);
    await database.run(sql`
      INSERT INTO workspaces (id, user_id, name, created_at)
      VALUES ('http-workspace', 'http-user', 'HTTP Workspace', ${startedAt - 900})
    `);
    await database.run(sql`
      INSERT INTO conversations
        (id, workspace_id, title, model_id, harness_id, status, created_at, updated_at)
      VALUES
        ('http-conversation', 'http-workspace', 'HTTP contract', 'gw-test', 'pi', 'done',
          ${startedAt - 800}, ${startedAt + 500})
    `);
    await database.run(sql`
      INSERT INTO runs
        (id, conversation_id, workspace_id, harness_id, model_id, prompt, started_at,
          ended_at, status, turns, tokens_in, tokens_out, tool_calls, tool_errors)
      VALUES
        ('http-run', 'http-conversation', 'http-workspace', 'pi', 'gw-test',
          'http-contract needle', ${startedAt}, ${startedAt + 500}, 'done', 2, 300, 40, 1, 0)
    `);
    await database.run(sql`
      INSERT INTO traces (id, conversation_id, run_id, step, fields, ts, duration_ms)
      VALUES
        ('http-trace', 'http-conversation', 'http-run', 'tool',
          ${JSON.stringify({ name: "search_docs", ok: true })}, ${startedAt + 300}, 200)
    `);

    const list = await createApp().request(
      "/api/admin/runs?userId=http-user&status=done&q=http-contract",
      { headers: admin },
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      total: 1,
      runs: [{ id: "http-run", userId: "http-user", durationMs: 500 }],
    });

    const detail = await createApp().request("/api/admin/runs/http-run", { headers: admin });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      run: { id: "http-run", userId: "http-user", durationMs: 500 },
      spans: [{ id: "http-trace", offsetMs: 100, durationMs: 200 }],
    });
  });

  it("creates, renames, invites, accepts once, and removes without workspaces", async () => {
    const created = await requestJson("/api/admin/organizations", "POST", admin, { name: " Claims " });
    expect(created.status).toBe(201);
    const organization = (await created.json() as { organization: { id: string; name: string } }).organization;
    expect(organization.name).toBe("Claims");

    const renamed = await requestJson(`/api/admin/organizations/${organization.id}`, "PATCH", admin, { name: "Operations" });
    expect(renamed.status).toBe(200);

    const issued = await requestJson(`/api/admin/organizations/${organization.id}/invitations`, "POST", admin, { email: "Person@Example.com" });
    expect(issued.status).toBe(201);
    const issueBody = await issued.json() as { url: string; invitation: { id: string } };
    const { env } = await import("./config/env");
    expect(issueBody.url).toStartWith(`${env.publicUrl}/invite#token=`);
    const token = issueBody.url.split("#token=")[1]!;

    const mismatch = await requestJson("/api/invitations/inspect", "POST", jsonHeaders("other", "other@example.com"), { token });
    expect(await mismatch.json()).toEqual({ state: "unavailable" });

    const accepted = await requestJson("/api/invitations/accept", "POST", invitee, { token });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ state: "joined", organization: { id: organization.id } });
    expect(await (await requestJson("/api/invitations/accept", "POST", invitee, { token })).json()).toEqual({ state: "used" });

    const detail = await createApp().request(`/api/admin/organizations/${organization.id}`, { headers: admin });
    const detailBody = await detail.json() as { members: Array<{ id: string; email: string }>; invitations: unknown[] };
    expect(detailBody.members).toHaveLength(1);
    expect(detailBody.members[0]!.email).toBe("person@example.com");
    expect(JSON.stringify(detailBody)).not.toContain(token);

    const removed = await createApp().request(`/api/admin/organizations/${organization.id}/members/${detailBody.members[0]!.id}`, { method: "DELETE", headers: admin });
    expect(removed.status).toBe(200);
    expect(
      await database
        .select({ count: sql<number>`count(*)` })
        .from(workspaceTable)
        .where(eq(workspaceTable.userId, "person-uid"))
        .get(),
    ).toEqual({ count: 0 });
  });

  it("requires JSON for token-bearing and management mutations", async () => {
    const headers = { "x-authentik-uid": "admin-uid", "x-authentik-email": "admin@example.com" };
    expect((await createApp().request("/api/admin/organizations", { method: "POST", headers, body: "name=x" })).status).toBe(415);
    expect((await createApp().request("/api/invitations/inspect", { method: "POST", headers, body: "token=x" })).status).toBe(415);
  });

  it("rejects an explicit cross-site mutation origin", async () => {
    const res = await requestJson(
      "/api/admin/organizations",
      "POST",
      { ...admin, origin: "https://attacker.example" },
      { name: "Should not exist" },
    );
    expect(res.status).toBe(403);
  });
});
