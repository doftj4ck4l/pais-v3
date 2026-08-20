import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAuth, currentUser, currentUserId } from "./auth";

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

  it("gives only the fallback dev identity its configured profile email", async () => {
    const app = new Hono();
    app.use(
      "*",
      createAuth({
        mode: "dev",
        header: "x-authentik-uid",
        defaultUserId: "local",
        defaultUserEmail: "admin@example.com",
      }),
    );
    app.get("/me", (c) => c.json(currentUser(c)));

    expect(await (await app.request("/me")).json()).toMatchObject({
      id: "local",
      email: "admin@example.com",
    });

    const claimed = await app.request("/me", {
      headers: { "x-authentik-uid": "alice" },
    });
    expect(await claimed.json()).toEqual({
      id: "alice",
      username: undefined,
      email: undefined,
      name: undefined,
      groups: [],
    });
  });
});

describe("local mode", () => {
  it("takes identity only from a valid local session cookie", async () => {
    const app = appWith({
      mode: "local",
      resolveLocalSession: async (token) =>
        token === "valid"
          ? { id: "local-user", email: "admin@example.com", groups: [] }
          : null,
    });

    const authenticated = await app.request("/who", {
      headers: { cookie: "pixelspace_session=valid" },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ userId: "local-user" });

    expect((await app.request("/who")).status).toBe(401);
    expect(
      (
        await app.request("/who", {
          headers: { "x-authentik-uid": "forged-proxy-user" },
        })
      ).status,
    ).toBe(401);
  });
});

describe("profile", () => {
  it("reads the display fields the proxy supplies", async () => {
    const app = new Hono();
    app.use("*", createAuth({ mode: "proxy" }));
    app.get("/me", (c) => c.json(currentUser(c)));

    const res = await app.request("/me", {
      headers: {
        "x-authentik-uid": "alice-uid",
        "x-authentik-username": "alice",
        "x-authentik-email": "alice@example.com",
        "x-authentik-name": "Alice Example",
        "x-authentik-groups": "engineering|admins",
      },
    });

    expect(await res.json()).toEqual({
      id: "alice-uid",
      username: "alice",
      email: "alice@example.com",
      name: "Alice Example",
      groups: ["engineering", "admins"],
    });
  });

  it("reports an empty group list when the header is absent", async () => {
    const app = new Hono();
    app.use("*", createAuth({ mode: "proxy" }));
    app.get("/me", (c) => c.json(currentUser(c)));

    const res = await app.request("/me", { headers: { "x-authentik-uid": "alice-uid" } });

    expect(await res.json()).toEqual({
      id: "alice-uid",
      username: undefined,
      email: undefined,
      name: undefined,
      groups: [],
    });
  });

  it("falls back to the default user in dev mode", async () => {
    const app = new Hono();
    app.use("*", createAuth({ mode: "dev", defaultUserId: "local" }));
    app.get("/me", (c) => c.json(currentUser(c)));

    expect(await (await app.request("/me")).json()).toMatchObject({ id: "local", groups: [] });
  });
});
