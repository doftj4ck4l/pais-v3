import { createHash, randomBytes, randomUUID } from "node:crypto";
import { env } from "../../config/env";
import {
  organizationStore,
  type OrganizationStore,
} from "../../repositories/organization.repository";
import type {
  OrganizationInvitationRow,
  OrganizationMemberRole,
  OrganizationRow,
} from "../../models/schema";
import { normalizeEmail } from "./policy";

export type InvitationState = "actionable" | "expired" | "revoked" | "used" | "unavailable";

export type PublicInvitation = {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationMemberRole;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  state: Exclude<InvitationState, "unavailable">;
};

export type InvitationInspection =
  | { state: "actionable"; organization: Pick<OrganizationRow, "id" | "name">; expiresAt: number }
  | { state: Exclude<InvitationState, "actionable"> };

export const digestInvitationToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const stateFor = (row: OrganizationInvitationRow, now: number): Exclude<InvitationState, "unavailable"> => {
  if (row.acceptedAt !== null) return "used";
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "actionable";
};

const publicInvitation = (row: OrganizationInvitationRow, now: number): PublicInvitation => ({
  id: row.id,
  organizationId: row.organizationId,
  email: row.email,
  role: row.role,
  expiresAt: row.expiresAt,
  acceptedAt: row.acceptedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
  state: stateFor(row, now),
});

export class OrganizationInvitationService {
  private readonly now: () => number;
  private readonly publicUrl: string;
  private readonly basePath: string;
  private readonly ttlMs: number;

  constructor(
    private readonly store: OrganizationStore = organizationStore,
    options: { publicUrl?: string; basePath?: string; ttlMs?: number; now?: () => number } = {},
  ) {
    this.publicUrl = (options.publicUrl ?? env.publicUrl).replace(/\/+$/, "");
    this.basePath = options.basePath ?? env.publicBasePath;
    this.ttlMs = options.ttlMs ?? env.organizationInviteTtlMs;
    this.now = options.now ?? Date.now;
  }

  async create(
    organizationId: string,
    recipientEmail: string,
    createdByUserId: string,
    role: OrganizationMemberRole = "member",
  ) {
    if (!(await this.store.getOrganization(organizationId))) {
      throw new Error("Organization not found.");
    }
    const email = normalizeEmail(recipientEmail);
    const now = this.now();
    await this.store.ensureUser(createdByUserId, now);
    const token = randomBytes(32).toString("base64url");
    const row: OrganizationInvitationRow = {
      id: `orginv_${randomUUID()}`,
      organizationId,
      email,
      tokenDigest: digestInvitationToken(token),
      role,
      expiresAt: now + this.ttlMs,
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      createdByUserId,
      createdAt: now,
    };
    await this.store.createInvitation(row, now);
    return {
      invitation: publicInvitation(row, now),
      // The fragment is not sent to reverse proxies or request loggers. The SPA
      // clears it before posting the token in a JSON body.
      url: `${this.publicUrl}${this.basePath}/invite#token=${token}`,
    };
  }

  async listInvitations(organizationId: string): Promise<PublicInvitation[]> {
    const now = this.now();
    return (await this.store.listInvitations(organizationId)).map((row) => publicInvitation(row, now));
  }

  async inspect(token: string, callerEmail: string | undefined): Promise<InvitationInspection> {
    const row = await this.lookupForCaller(token, callerEmail);
    if (!row) return { state: "unavailable" };
    const state = stateFor(row, this.now());
    if (state !== "actionable") return { state };
    const organization = await this.store.getOrganization(row.organizationId);
    if (!organization) return { state: "unavailable" };
    return {
      state: "actionable",
      organization: { id: organization.id, name: organization.name },
      expiresAt: row.expiresAt,
    };
  }

  async accept(
    token: string,
    caller: { userId: string; email: string | undefined },
  ): Promise<InvitationInspection | { state: "joined"; organization: Pick<OrganizationRow, "id" | "name"> }> {
    const row = await this.lookupForCaller(token, caller.email);
    if (!row) return { state: "unavailable" };
    const before = stateFor(row, this.now());
    if (before !== "actionable") return { state: before };
    const organization = await this.store.getOrganization(row.organizationId);
    if (!organization) return { state: "unavailable" };

    const now = this.now();
    const accepted = await this.store.acceptInvitation({
      tokenDigest: row.tokenDigest,
      email: row.email,
      userId: caller.userId,
      now,
      membershipId: `orgmem_${randomUUID()}`,
      // The membership takes the role the invitation was created with, so an
      // admin invite lands as an admin without a second promotion step.
      role: row.role,
    });
    if (!accepted) return this.inspect(token, caller.email);
    return { state: "joined", organization: { id: organization.id, name: organization.name } };
  }

  async revoke(organizationId: string, invitationId: string): Promise<boolean> {
    return this.store.revokeInvitation(organizationId, invitationId, this.now());
  }

  private async lookupForCaller(
    token: string,
    callerEmail: string | undefined,
  ): Promise<OrganizationInvitationRow | null> {
    if (!callerEmail || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    let normalized: string;
    try {
      normalized = normalizeEmail(callerEmail);
    } catch {
      return null;
    }
    const row = await this.store.findInvitationByDigest(digestInvitationToken(token));
    return row?.email === normalized ? row : null;
  }
}

export const organizationInvitationService = new OrganizationInvitationService();
