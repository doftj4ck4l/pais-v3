/** Normalize an email used as an authenticated account identifier. */
export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  // The identity provider or local account flow owns full validation. This
  // rejects malformed input without pretending to implement all of RFC 5322.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}
