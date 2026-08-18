import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteOrganizationStore } from "./organization.repository";
import { OrganizationInvitationService } from "../services/organizations/invitation.service";

let sqlite: Database;
let store: SqliteOrganizationStore;
let service: OrganizationInvitationService;
let now: number;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  applySchema(sqlite);
  store = new SqliteOrganizationStore(drizzle(sqlite) as never);
  now = 1_800_000_000_000;
  service = new OrganizationInvitationService(store, {
    publicUrl: "https://salur.example",
    ttlMs: 1_000,
    now: () => now,
  });
  await store.ensureUser("admin");
  for (const id of ["org-a", "org-b"]) {
    await store.createOrganization({ id, name: id, createdByUserId: "admin", createdAt: 1, updatedAt: 1 });
  }
});

describe("organization membership persistence", () => {
  it("lets one user join multiple organizations without touching private workspaces", async () => {
    sqlite.query("insert into users (id, created_at) values ('member', 1)").run();
    sqlite.query("insert into workspaces (id, user_id, name, created_at) values ('private-ws', 'member', 'Private', 1)").run();

    for (const organizationId of ["org-a", "org-b"]) {
      const issued = await service.create(organizationId, "member@example.com", "admin");
      const token = issued.url.split("#token=")[1]!;
      expect((await service.accept(token, { userId: "member", email: "member@example.com" })).state).toBe("joined");
    }
    expect(await store.listMemberships("org-a")).toHaveLength(1);
    expect(await store.listMemberships("org-b")).toHaveLength(1);

    const [membership] = await store.listMemberships("org-a");
    expect(await store.removeMembership("org-a", membership!.id)).toBe(true);
    expect(await store.listMemberships("org-b")).toHaveLength(1);
    expect(sqlite.query("select id, user_id from workspaces where id = 'private-ws'").get()).toEqual({ id: "private-ws", user_id: "member" });
  });

  it("makes expiry a terminal state that cannot be accepted or revoked", async () => {
    const issued = await service.create("org-a", "late@example.com", "admin");
    const token = issued.url.split("#token=")[1]!;
    now += 1_000;
    expect(await service.inspect(token, "late@example.com")).toEqual({ state: "expired" });
    expect(await service.accept(token, { userId: "late", email: "late@example.com" })).toEqual({ state: "expired" });
    expect(await service.revoke("org-a", issued.invitation.id)).toBe(false);
  });

  it("returns membership and actionable invitation counts in one summary contract", async () => {
    const accepted = await service.create("org-a", "member@example.com", "admin");
    await service.accept(accepted.url.split("#token=")[1]!, {
      userId: "member",
      email: "member@example.com",
    });
    await service.create("org-a", "pending@example.com", "admin");
    const summaries = await store.listOrganizationSummaries(now);
    expect(summaries.find((row) => row.id === "org-a")).toMatchObject({
      memberCount: 1,
      pendingInvitationCount: 1,
    });
  });
});
