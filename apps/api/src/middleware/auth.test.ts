import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuth, currentUserId } from "./auth";

/** A minimal app that reports whichever user id the middleware resolved. */
const appWith = (opts: Parameters<typeof createAuth>[0]) => {
  const app = new Hono();
  app.use("*", createAuth(opts));
  app.get("/who", (c) => c.json({ userId: currentUserId(c) }));
  return app;
};

describe("proxy mode", () => {
  it("takes the user id from the trusted header", async () => {
    const app = appWith({ mode: "proxy", header: "x-authentik-uid" });

    const res = await app.request("/who", {
      headers: { "x-authentik-uid": "alice" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "alice" });
  });

  it("ignores a userId supplied in the query string", async () => {
    // The whole point of the change: before this, ?userId= reached the
    // registry and read another tenant's workspaces.
    const app = appWith({ mode: "proxy", header: "x-authentik-uid" });

    const res = await app.request("/who?userId=bob", {
      headers: { "x-authentik-uid": "alice" },
    });

    expect(await res.json()).toEqual({ userId: "alice" });
  });

  it("rejects a request with no trusted header", async () => {
    const app = appWith({ mode: "proxy", header: "x-authentik-uid" });

    const res = await app.request("/who");

    expect(res.status).toBe(401);
  });

  it("rejects a header that is only whitespace", async () => {
    const app = appWith({ mode: "proxy", header: "x-authentik-uid" });

    const res = await app.request("/who", {
      headers: { "x-authentik-uid": "   " },
    });

    expect(res.status).toBe(401);
  });
});

describe("dev mode", () => {
  it("falls back to the default user when no header is present", async () => {
    const app = appWith({ mode: "dev", header: "x-authentik-uid", defaultUserId: "local" });

    const res = await app.request("/who");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "local" });
  });

  it("still prefers the header when one is present", async () => {
    const app = appWith({ mode: "dev", header: "x-authentik-uid", defaultUserId: "local" });

    const res = await app.request("/who", {
      headers: { "x-authentik-uid": "alice" },
    });

    expect(await res.json()).toEqual({ userId: "alice" });
  });

  it("ignores a userId supplied in the query string", async () => {
    const app = appWith({ mode: "dev", header: "x-authentik-uid", defaultUserId: "local" });

    const res = await app.request("/who?userId=bob");

    expect(await res.json()).toEqual({ userId: "local" });
  });
});
