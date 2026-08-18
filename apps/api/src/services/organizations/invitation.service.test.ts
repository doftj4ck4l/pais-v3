import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteOrganizationStore } from "../../repositories/organization.repository";
import { OrganizationInvitationService, digestInvitationToken } from "./invitation.service";

let sqlite: Database;
let store: SqliteOrganizationStore;
let service: OrganizationInvitationService;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  applySchema(sqlite);
  store = new SqliteOrganizationStore(drizzle(sqlite) as never);
  service = new OrganizationInvitationService(store, {
    publicUrl: "https://salur.internal/",
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    now: () => 1_800_000_000_000,
  });
  await store.ensureUser("admin-uid");
  await store.createOrganization({ id: "org-1", name: "Claims", createdByUserId: "admin-uid", createdAt: 1, updatedAt: 1 });
});

describe("secure organization invitations", () => {
  it("returns a fragment link once and persists only a digest", async () => {
    const created = await service.create("org-1", " Person@Example.COM ", "admin-uid");
    expect(created.url).toStartWith("https://salur.internal/invite#token=");
    const token = created.url.split("#token=")[1]!;
    expect(Buffer.from(token, "base64url")).toHaveLength(32);

    const raw = sqlite.query("select token_digest from organization_invitations where id = ?").get(created.invitation.id) as { token_digest: string };
    expect(raw.token_digest).toBe(digestInvitationToken(token));
    expect(raw.token_digest).not.toContain(token);

    const listed = await service.listInvitations("org-1");
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed[0]).not.toHaveProperty("tokenDigest");
    expect(listed[0]).not.toHaveProperty("url");
  });

  it("accepts once for the matching trusted email without creating a workspace", async () => {
    const created = await service.create("org-1", "person@example.com", "admin-uid");
    const token = created.url.split("#token=")[1]!;

    expect(await service.accept(token, { userId: "person-uid", email: "PERSON@example.com" })).toEqual({ state: "joined", organization: { id: "org-1", name: "Claims" } });
    expect(await service.accept(token, { userId: "person-uid", email: "person@example.com" })).toEqual({ state: "used" });
    expect(sqlite.query("select count(*) as count from organization_memberships").get()).toEqual({ count: 1 });
    expect(sqlite.query("select count(*) as count from workspaces where user_id = 'person-uid'").get()).toEqual({ count: 0 });
  });

  it("does not disclose an invitation to a different authenticated email", async () => {
    const created = await service.create("org-1", "person@example.com", "admin-uid");
    const token = created.url.split("#token=")[1]!;
    expect(await service.inspect(token, "other@example.com")).toEqual({ state: "unavailable" });
    expect(await service.accept(token, { userId: "other-uid", email: "other@example.com" })).toEqual({ state: "unavailable" });
  });

  it("supersedes an earlier pending invitation and supports revocation", async () => {
    const first = await service.create("org-1", "person@example.com", "admin-uid");
    const second = await service.create("org-1", "person@example.com", "admin-uid");
    const firstToken = first.url.split("#token=")[1]!;
    expect(await service.inspect(firstToken, "person@example.com")).toEqual({ state: "revoked" });
    expect(await service.revoke("org-1", second.invitation.id)).toBe(true);
    expect(await service.revoke("org-1", second.invitation.id)).toBe(false);
  });
});
