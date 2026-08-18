import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { currentUserId } from "../middleware/auth";
import { organizationStore } from "../repositories/organization.repository";
import { organizationInvitationService } from "../services/organizations/invitation.service";

const MAX_NAME = 80;

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
  const userId = currentUserId(c);
  try {
    const result = await organizationInvitationService.create(
      c.req.param("organizationId") ?? "",
      body.email,
      userId,
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
  const removed = await organizationStore.removeMembership(
    organizationId,
    c.req.param("membershipId") ?? "",
  );
  if (removed) return c.json({ ok: true });
  return (await organizationStore.getOrganization(organizationId))
    ? c.json({ error: "Member not found." }, 404)
    : c.json({ error: "Organization not found." }, 404);
}
