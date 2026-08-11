import { beforeAll, describe, expect, it } from "bun:test";

/**
 * These assert the wiring, not the middleware itself: that tenant-scoped
 * routes are behind auth and that the one route the container healthcheck
 * calls is not.
 *
 * The schema is applied first even though nothing here is about storage:
 * `/api/me` reads the display name, so it needs tables. Without this the file
 * passes on a machine whose working database happens to be migrated and fails
 * on a fresh checkout, which is what CI is every time.
 */
let createApp: typeof import("./app").createApp;

beforeAll(async () => {
  // DB_PATH is already a throwaway under `bun test`; this fills it in.
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));
});
describe("api auth wiring", () => {
  it("refuses a tenant-scoped route with no identity", async () => {
    const res = await createApp().request("/api/workspaces");

    expect(res.status).toBe(401);
  });

  it("leaves /api/meta open for the container healthcheck", async () => {
    const res = await createApp().request("/api/meta");

    expect(res.status).toBe(200);
  });
});

describe("GET /api/me", () => {
  it("reports the authenticated identity", async () => {
    const res = await createApp().request("/api/me", {
      headers: {
        "x-authentik-uid": "alice-uid",
        "x-authentik-username": "alice",
        "x-authentik-email": "alice@example.com",
        "x-authentik-groups": "engineering|admins",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "alice-uid",
      username: "alice",
      email: "alice@example.com",
      groups: ["engineering", "admins"],
    });
  });

  it("is itself behind auth", async () => {
    const res = await createApp().request("/api/me");

    expect(res.status).toBe(401);
  });
});
