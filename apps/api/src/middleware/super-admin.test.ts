import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuth } from "./auth";
import { createRequireSuperAdmin } from "./super-admin";

const app = new Hono();
app.use("*", createAuth({ mode: "proxy" }));
app.use("*", createRequireSuperAdmin(["admin@example.com"]));
app.get("/", (c) => c.json({ ok: true }));

describe("super-admin middleware", () => {
  it("allows the configured trusted email", async () => {
    const res = await app.request("/", { headers: { "x-authentik-uid": "1", "x-authentik-email": "ADMIN@example.com" } });
    expect(res.status).toBe(200);
  });

  it("rejects a caller with a different or absent email", async () => {
    expect((await app.request("/", { headers: { "x-authentik-uid": "1", "x-authentik-email": "other@example.com" } })).status).toBe(403);
    expect((await app.request("/", { headers: { "x-authentik-uid": "1" } })).status).toBe(403);
  });
});
