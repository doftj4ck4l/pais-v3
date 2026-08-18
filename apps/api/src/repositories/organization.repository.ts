import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  organizationInvitations,
  organizationMemberships,
  organizations,
  users,
  type OrganizationInvitationRow,
  type OrganizationMembershipRow,
  type OrganizationRow,
} from "../models/schema";

export type NewOrganization = OrganizationRow;
export type NewOrganizationInvitation = OrganizationInvitationRow;
export type OrganizationSummaryRow = OrganizationRow & {
  memberCount: number;
  pendingInvitationCount: number;
};

export interface OrganizationStore {
  ensureUser(userId: string, createdAt?: number): Promise<void>;
  listOrganizations(): Promise<OrganizationRow[]>;
  listOrganizationSummaries(now: number): Promise<OrganizationSummaryRow[]>;
  getOrganization(id: string): Promise<OrganizationRow | null>;
  createOrganization(input: NewOrganization): Promise<OrganizationRow>;
  renameOrganization(id: string, name: string, updatedAt: number): Promise<OrganizationRow | null>;
  listMemberships(organizationId: string): Promise<OrganizationMembershipRow[]>;
  removeMembership(organizationId: string, membershipId: string): Promise<boolean>;
  listInvitations(organizationId: string): Promise<OrganizationInvitationRow[]>;
  findInvitationByDigest(tokenDigest: string): Promise<OrganizationInvitationRow | null>;
  createInvitation(input: NewOrganizationInvitation, now: number): Promise<void>;
  revokeInvitation(organizationId: string, invitationId: string, now: number): Promise<boolean>;
  acceptInvitation(input: {
    tokenDigest: string;
    email: string;
    userId: string;
    now: number;
    membershipId: string;
  }): Promise<boolean>;
}

export class SqliteOrganizationStore implements OrganizationStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async ensureUser(userId: string, createdAt = Date.now()): Promise<void> {
    this.dbImpl.insert(users).values({ id: userId, createdAt }).onConflictDoNothing().run();
  }

  async listOrganizations(): Promise<OrganizationRow[]> {
    return (await this.dbImpl.select().from(organizations).orderBy(asc(organizations.name))) as OrganizationRow[];
  }

  async listOrganizationSummaries(now: number): Promise<OrganizationSummaryRow[]> {
    const [rows, membershipCounts, invitationCounts] = await Promise.all([
      this.listOrganizations(),
      this.dbImpl
        .select({ organizationId: organizationMemberships.organizationId, count: count() })
        .from(organizationMemberships)
        .groupBy(organizationMemberships.organizationId),
      this.dbImpl
        .select({ organizationId: organizationInvitations.organizationId, count: count() })
        .from(organizationInvitations)
        .where(
          and(
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
            gt(organizationInvitations.expiresAt, now),
          ),
        )
        .groupBy(organizationInvitations.organizationId),
    ]);
    const members = new Map(membershipCounts.map((row) => [row.organizationId, row.count]));
    const invitations = new Map(invitationCounts.map((row) => [row.organizationId, row.count]));
    return rows.map((row) => ({
      ...row,
      memberCount: members.get(row.id) ?? 0,
      pendingInvitationCount: invitations.get(row.id) ?? 0,
    }));
  }

  async getOrganization(id: string): Promise<OrganizationRow | null> {
    const row = await this.dbImpl.select().from(organizations).where(eq(organizations.id, id)).get();
    return (row as OrganizationRow | undefined) ?? null;
  }

  async createOrganization(input: NewOrganization): Promise<OrganizationRow> {
    this.dbImpl.insert(organizations).values(input).run();
    return input;
  }

  async renameOrganization(id: string, name: string, updatedAt: number): Promise<OrganizationRow | null> {
    const changed = this.dbImpl
      .update(organizations)
      .set({ name, updatedAt })
      .where(eq(organizations.id, id))
      .returning()
      .get();
    return (changed as OrganizationRow | undefined) ?? null;
  }

  async listMemberships(organizationId: string): Promise<OrganizationMembershipRow[]> {
    return (await this.dbImpl
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, organizationId))
      .orderBy(desc(organizationMemberships.joinedAt))) as OrganizationMembershipRow[];
  }

  async removeMembership(organizationId: string, membershipId: string): Promise<boolean> {
    const changed = this.dbImpl
      .delete(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.id, membershipId)))
      .returning({ id: organizationMemberships.id })
      .get();
    return Boolean(changed);
  }

  async listInvitations(organizationId: string): Promise<OrganizationInvitationRow[]> {
    return (await this.dbImpl
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.organizationId, organizationId))
      .orderBy(desc(organizationInvitations.createdAt))) as OrganizationInvitationRow[];
  }

  async findInvitationByDigest(tokenDigest: string): Promise<OrganizationInvitationRow | null> {
    const row = await this.dbImpl
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenDigest, tokenDigest))
      .get();
    return (row as OrganizationInvitationRow | undefined) ?? null;
  }

  async createInvitation(input: NewOrganizationInvitation, now: number): Promise<void> {
    this.dbImpl.transaction((tx) => {
      // A newly copied link is the only actionable link for this recipient/org.
      tx.update(organizationInvitations)
        .set({ revokedAt: now })
        .where(
          and(
            eq(organizationInvitations.organizationId, input.organizationId),
            eq(organizationInvitations.email, input.email),
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
          ),
        )
        .run();
      tx.insert(organizationInvitations).values(input).run();
    });
  }

  async revokeInvitation(organizationId: string, invitationId: string, now: number): Promise<boolean> {
    const changed = this.dbImpl
      .update(organizationInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(organizationInvitations.id, invitationId),
          eq(organizationInvitations.organizationId, organizationId),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.revokedAt),
          gt(organizationInvitations.expiresAt, now),
        ),
      )
      .returning({ id: organizationInvitations.id })
      .get();
    return Boolean(changed);
  }

  async acceptInvitation(input: {
    tokenDigest: string;
    email: string;
    userId: string;
    now: number;
    membershipId: string;
  }): Promise<boolean> {
    return this.dbImpl.transaction((tx) => {
      // Claim first. If a later insert fails, SQLite rolls the claim back with
      // the transaction, so the invite cannot be consumed without membership.
      const claimed = tx
        .update(organizationInvitations)
        // acceptedByUserId references users; claim before bootstrapping the
        // zero-workspace invitee, then attach the id later in this transaction.
        .set({ acceptedAt: input.now })
        .where(
          and(
            eq(organizationInvitations.tokenDigest, input.tokenDigest),
            eq(organizationInvitations.email, input.email),
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
            gt(organizationInvitations.expiresAt, input.now),
          ),
        )
        .returning({ organizationId: organizationInvitations.organizationId })
        .get();
      if (!claimed) return false;

      tx.insert(users)
        .values({ id: input.userId, createdAt: input.now })
        .onConflictDoNothing()
        .run();
      tx.update(organizationInvitations)
        .set({ acceptedByUserId: input.userId })
        .where(eq(organizationInvitations.tokenDigest, input.tokenDigest))
        .run();
      tx.insert(organizationMemberships)
        .values({
          id: input.membershipId,
          organizationId: claimed.organizationId,
          userId: input.userId,
          email: input.email,
          joinedAt: input.now,
        })
        .onConflictDoNothing()
        .run();
      return true;
    });
  }
}

export const organizationStore: OrganizationStore = new SqliteOrganizationStore();
