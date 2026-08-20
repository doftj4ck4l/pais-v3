import { normalizeEmail } from "../auth/identity";

export { normalizeEmail } from "../auth/identity";

export function parseSuperAdminEmails(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(",").filter((value) => value.trim()).map(normalizeEmail))];
}

export function isSuperAdmin(email: string | undefined, allowedEmails: readonly string[]): boolean {
  if (!email || allowedEmails.length === 0) return false;
  try {
    return allowedEmails.includes(normalizeEmail(email));
  } catch {
    return false;
  }
}
