/** Normalize the identity-provider email used by organization policy. */
export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  // The proxy owns full address validation. This rejects malformed input and
  // accidental display-name strings without pretending to implement RFC 5322.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

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
