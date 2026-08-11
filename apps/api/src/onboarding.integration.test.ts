import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Drives the real HTTP surface against a throwaway database, so the first-run
 * behaviour is asserted end to end rather than at the repository boundary —
 * the bug this guards against lives in the controller, not the registry.
 */
let dir: string;
let createApp: typeof import("./app").createApp;

const asUser = (id: string) => ({ headers: { "x-authentik-uid": id } });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "salur-onboarding-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  // The server applies the schema at boot; this stands in for that.
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("first run", () => {
  it("reports no workspaces for a user who has never made one", async () => {
    // Listing used to call resolve() first, which created "Default" as a side
    // effect — the console could never tell a new user from an existing one,
    // so onboarding was impossible to write.
    const res = await createApp().request("/api/workspaces", asUser("brand-new-user"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaces: [] });
  });

  it("returns the workspace once the user creates one", async () => {
    const app = createApp();

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { ...asUser("onboarding-user").headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    expect(created.status).toBe(201);

    const res = await app.request("/api/workspaces", asUser("onboarding-user"));
    const { workspaces } = (await res.json()) as { workspaces: { name: string }[] };

    expect(workspaces.map((w) => w.name)).toEqual(["Research"]);
  });

  it("keeps one user's workspaces out of another's list", async () => {
    const app = createApp();

    const res = await app.request("/api/workspaces", asUser("someone-else"));

    expect(await res.json()).toEqual({ workspaces: [] });
  });
});
