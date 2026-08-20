import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "./app";
import { env } from "./config/env";
import { ensureSchema } from "./db/client";
import { createAuth } from "./middleware/auth";
import { localAuthService } from "./services/auth/local-auth.service";

const email = `local-admin-${crypto.randomUUID()}@example.com`;
const password = "correct horse battery staple";
const originalMode = env.authMode;
const originalAdmins = env.superAdminEmails;

const app = createApp({ authMiddleware: createAuth({ mode: "local" }) });

beforeAll(async () => {
  ensureSchema();
  (env as { authMode: typeof env.authMode }).authMode = "local";
  (env as { superAdminEmails: string[] }).superAdminEmails = [email];
  await localAuthService.bootstrap(email, password);
});

afterAll(() => {
  (env as { authMode: typeof env.authMode }).authMode = originalMode;
  (env as { superAdminEmails: string[] }).superAdminEmails = originalAdmins;
});

describe("local password authentication", () => {
  it("announces password login without requiring a session", async () => {
    const res = await app.request("/api/auth/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "local", passwordLogin: true });
  });

  it("rejects invalid credentials without revealing which field was wrong", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "this password is wrong" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Email or password is incorrect." });
  });

  it("throttles repeated failures and bounds concurrent password verification", async () => {
    const repeatedEmail = `repeated-${crypto.randomUUID()}@example.com`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: repeatedEmail, password: "wrong password here" }),
      });
      expect(res.status).toBe(401);
    }
    const throttled = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: repeatedEmail, password: "wrong password here" }),
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("900");

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        app.request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: `rotating-${index}-${crypto.randomUUID()}@example.com`,
            password: "wrong password here",
          }),
        }),
      ),
    );
    expect(concurrent.filter((res) => res.status === 401)).toHaveLength(4);
    expect(concurrent.filter((res) => res.status === 429)).toHaveLength(2);
  });

  it("rejects a streamed login body once it exceeds the byte limit", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ email, password: "x".repeat(9_000) })));
        controller.close();
      },
    });
    const res = await app.request(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body is too large." });
  });

  it("creates an HttpOnly session that authenticates the existing admin policy", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    expect(await login.clone().json()).toMatchObject({
      user: {
        email,
        authMode: "local",
        canAdministerOrganizations: true,
      },
    });
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("pixelspace_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");

    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      email,
      authMode: "local",
      canAdministerOrganizations: true,
    });

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });

  it("rejects cross-origin login submissions", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(403);
  });
});
