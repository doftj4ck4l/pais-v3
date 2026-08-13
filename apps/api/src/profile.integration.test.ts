import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The display name, end to end over the real HTTP surface.
 *
 * A throwaway database because these write: pointed at the working one they
 * would rename whoever last used `bun dev`.
 *
 * What is being asserted is the layering. The provider owns the identity and
 * sends it on every request; this console owns one preference and stores it.
 * The response has to show the result of laying the second over the first, and
 * still report the override on its own, or the settings screen cannot tell
 * "set to the same thing" from "not set".
 */
let dir: string;
let createApp: typeof import("./app").createApp;

const AS_ALICE = {
  "x-authentik-uid": "alice-uid",
  "x-authentik-username": "alice",
  "x-authentik-name": "Alice From Authentik",
  "content-type": "application/json",
};

/** The merged profile as the console reads it. */
type Profile = {
  name?: string;
  username?: string;
  displayName: string | null;
  providerName: string | null;
};

const patch = (headers: Record<string, string>, body: unknown) =>
  createApp().request("/api/me", { method: "PATCH", headers, body: JSON.stringify(body) });

const profile = async (res: Response) => (await res.json()) as Profile;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-profile-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  // The server applies the schema at boot; this stands in for that.
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PATCH /api/me", () => {
  it("uses the provider's name until one is set here", async () => {
    const res = await createApp().request("/api/me", { headers: AS_ALICE });
    const body = await profile(res);

    expect(body.name).toBe("Alice From Authentik");
    expect(body.displayName).toBeNull();
  });

  it("lays a stored name over the provider's, and reports both", async () => {
    const res = await patch(AS_ALICE, { displayName: "  Alice  " });
    expect(res.status).toBe(200);

    const body = await profile(res);
    expect(body.name).toBe("Alice");
    expect(body.displayName).toBe("Alice");
    // The provider's own name survives the override, so the settings field can
    // say what clearing it would restore.
    expect(body.providerName).toBe("Alice From Authentik");
    // Everything else still comes from the headers, untouched.
    expect(body.username).toBe("alice");
  });

  it("keeps it across requests", async () => {
    await patch(AS_ALICE, { displayName: "Alice" });
    const body = await profile(await createApp().request("/api/me", { headers: AS_ALICE }));

    expect(body.name).toBe("Alice");
  });

  it("clears back to the provider's name on an empty string", async () => {
    await patch(AS_ALICE, { displayName: "Alice" });
    const body = await profile(await patch(AS_ALICE, { displayName: "" }));

    expect(body.displayName).toBeNull();
    expect(body.name).toBe("Alice From Authentik");
  });

  it("does not let one person's name reach another", async () => {
    await patch(AS_ALICE, { displayName: "Alice" });
    const bob = { "x-authentik-uid": "bob-uid", "x-authentik-name": "Bob", "content-type": "application/json" };

    const body = await profile(await createApp().request("/api/me", { headers: bob }));
    expect(body.name).toBe("Bob");
    expect(body.displayName).toBeNull();
  });

  it("refuses a name that is not a string", async () => {
    expect((await patch(AS_ALICE, { displayName: 42 })).status).toBe(400);
  });

  it("refuses a name longer than a name", async () => {
    expect((await patch(AS_ALICE, { displayName: "x".repeat(81) })).status).toBe(400);
  });

  it("refuses a caller the proxy did not identify", async () => {
    const res = await createApp().request("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "nobody" }),
    });
    expect(res.status).toBe(401);
  });
});
