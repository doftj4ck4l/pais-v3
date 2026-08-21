import { env } from "../../config/env";
import { workspaceRegistry } from "../../repositories/workspace-registry.repository";
import { isSuperAdmin } from "../organizations/policy";
import type { UserProfile } from "./types";

export type AuthenticatedProfile = UserProfile & {
  displayName: string | null;
  providerName: string | null;
  canAdministerOrganizations: boolean;
  authMode: typeof env.authMode;
};

/** Apply Pixelspace-owned profile and authorization fields to an authenticated identity. */
export async function authenticatedProfileFor(identity: UserProfile): Promise<AuthenticatedProfile> {
  const displayName = await workspaceRegistry.displayName(identity.id);
  return {
    ...identity,
    name: displayName ?? identity.name,
    displayName,
    providerName: identity.name ?? null,
    canAdministerOrganizations: isSuperAdmin(identity.email, env.superAdminEmails),
    authMode: env.authMode,
  };
}
