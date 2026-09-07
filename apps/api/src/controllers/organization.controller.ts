import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { currentUserId } from "../middleware/auth";
import { organizationStore } from "../repositories/organization.repository";
import { databaseGrantStore } from "../repositories/database-grants.repository";
import type { OrganizationMemberRole } from "../models/schema";
import { organizationInvitationService } from "../services/organizations/invitation.service";

const MAX_NAME = 80;

const ORGANIZATION_ROLES: OrganizationMemberRole[] = ["admin", "member"];

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function organizationName(body: Record<string, unknown> | null): string | null {
  if (typeof body?.name !== "string") return null;
  const name = body.name.trim();
  return name.length > 0 && name.length <= MAX_NAME ? name : null;
}

function membershipRole(body: Record<string, unknown> | null): OrganizationMemberRole | null {
  return body?.role && ORGANIZATION_ROLES.includes(body.role as OrganizationMemberRole)
    ? (body.role as OrganizationMemberRole)
    : null;
}

function connectionIds(body: Record<string, unknown> | null): string[] | null {
  if (!Array.isArray(body?.connectionIds)) return null;
  return body.connectionIds.filter((id): id is string => typeof id === "string");
}

/**
 * A department must keep at least one admin, or nobody could ever manage it
 * after the superadmin moves on. Both the demote and the remove paths hit this
 * so a role change can never strand a department.
 */
async function isLastAdmin(organizationId: string, membershipId: string): Promise<boolean> {
  const memberships = await organizationStore.listMemberships(organizationId);
  const target = memberships.find((m) => m.id === membershipId);
  if (!target || target.role !== "admin") return false;
  return memberships.filter((m) => m.role === "admin").length <= 1;
}

export async function listOrganizations(c: Context) {
  return c.json({ organizations: await organizationStore.listOrganizationSummaries(Date.now()) });
}

export async function createOrganization(c: Context) {
  const name = organizationName(await jsonBody(c));
  if (!name) return c.json({ error: `name must be between 1 and ${MAX_NAME} characters.` }, 400);
  const userId = currentUserId(c);
  const now = Date.now();
  await organizationStore.ensureUser(userId, now);
  const organization = await organizationStore.createOrganization({
    id: `org_${randomUUID()}`,
    name,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ organization }, 201);
}

export async function renameOrganization(c: Context) {
  const name = organizationName(await jsonBody(c));
  if (!name) return c.json({ error: `name must be between 1 and ${MAX_NAME} characters.` }, 400);
  const organization = await organizationStore.renameOrganization(
    c.req.param("organizationId") ?? "",
    name,
    Date.now(),
  );
  return organization
    ? c.json({ organization })
    : c.json({ error: "Organization not found." }, 404);
}

export async function showOrganization(c: Context) {
  const id = c.req.param("organizationId") ?? "";
  const organization = await organizationStore.getOrganization(id);
  if (!organization) return c.json({ error: "Organization not found." }, 404);
  const [members, invitations] = await Promise.all([
    organizationStore.listMemberships(id),
    organizationInvitationService.listInvitations(id),
  ]);
  return c.json({ organization, members, invitations });
}

export async function createInvitation(c: Context) {
  const body = await jsonBody(c);
  if (typeof body?.email !== "string") {
    return c.json({ error: "email must be a valid email address." }, 400);
  }
  // Role-less invites default to member; that keeps the endpoint compatible
  // with clients that predate roles while still allowing an admin invite.
  const role = body?.role === undefined ? "member" : membershipRole(body);
  if (!role) return c.json({ error: "role must be 'admin' or 'member'." }, 400);
  const userId = currentUserId(c);
  try {
    const result = await organizationInvitationService.create(
      c.req.param("organizationId") ?? "",
      body.email,
      userId,
      role,
    );
    return c.json(result, 201);
  } catch (error) {
    const message = (error as Error).message;
    const status = message === "Organization not found." ? 404 : 400;
    return c.json({ error: status === 404 ? message : "email must be a valid email address." }, status);
  }
}

export async function revokeInvitation(c: Context) {
  const organizationId = c.req.param("organizationId") ?? "";
  const revoked = await organizationInvitationService.revoke(
    organizationId,
    c.req.param("invitationId") ?? "",
  );
  if (revoked) return c.json({ ok: true });
  return (await organizationStore.getOrganization(organizationId))
    ? c.json({ error: "Invitation is not pending." }, 409)
    : c.json({ error: "Organization not found." }, 404);
}

export async function removeMember(c: Context) {
  const organizationId = c.req.param("organizationId") ?? "";
  const membershipId = c.req.param("membershipId") ?? "";
  if (await isLastAdmin(organizationId, membershipId)) {
    return c.json({ error: "A department needs at least one admin." }, 409);
  }
  const removed = await organizationStore.removeMembership(organizationId, membershipId);
  if (removed) return c.json({ ok: true });
  return (await organizationStore.getOrganization(organizationId))
    ? c.json({ error: "Member not found." }, 404)
    : c.json({ error: "Organization not found." }, 404);
}

export async function setMemberRole(c: Context) {
  const body = await jsonBody(c);
  const role = membershipRole(body);
  if (!role) return c.json({ error: "role must be 'admin' or 'member'." }, 400);
  const organizationId = c.req.param("organizationId") ?? "";
  const membershipId = c.req.param("membershipId") ?? "";
  if (role === "member" && (await isLastAdmin(organizationId, membershipId))) {
    return c.json({ error: "A department needs at least one admin." }, 409);
  }
  const changed = await organizationStore.setMembershipRole(organizationId, membershipId, role);
  if (changed) return c.json({ ok: true });
  return (await organizationStore.getOrganization(organizationId))
    ? c.json({ error: "Member not found." }, 404)
    : c.json({ error: "Organization not found." }, 404);
}

const organizationExists = async (c: Context): Promise<boolean> =>
  (await organizationStore.getOrganization(c.req.param("organizationId") ?? "")) !== null;

export async function listGrants(c: Context) {
  if (!(await organizationExists(c))) return c.json({ error: "Organization not found." }, 404);
  const connectionIds = await databaseGrantStore.listGrantedConnectionIds(
    c.req.param("organizationId") ?? "",
  );
  return c.json({ connectionIds });
}

export async function setGrants(c: Context) {
  const organizationId = c.req.param("organizationId") ?? "";
  if (!(await organizationExists(c))) return c.json({ error: "Organization not found." }, 404);
  const body = await jsonBody(c);
  const requested = connectionIds(body);
  if (!requested) return c.json({ error: "connectionIds must be an array." }, 400);

  // A grant hands out a *connection*, which resolves to a credential at query
  // time. Only grant connections the caller owns — a superadmin must never be
  // able to hand a colleague's database to someone else's department.
  const owned = new Set(await databaseGrantStore.connectionsOwnedByUser(currentUserId(c)));
  const foreign = requested.filter((id) => !owned.has(id));
  if (foreign.length) {
    return c.json(
      { error: "connectionIds references a database you do not own." },
      403,
    );
  }
  await databaseGrantStore.setGrants(organizationId, requested, currentUserId(c), Date.now());
  return c.json({ connectionIds: requested });
}
