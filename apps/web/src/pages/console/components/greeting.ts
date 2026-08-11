import type { UserProfile } from '@/shared/lib/types'

/**
 * Which part of the day it is, by the reader's clock.
 *
 * Four bands rather than three. Night is its own greeting because this console
 * gets used at two in the morning and "good evening" at 02:00 is the kind of
 * small wrongness that makes software feel like it is not paying attention.
 */
export function partOfDay(at: Date): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = at.getHours()
  // Small hours first. Ordering these ascending and letting `< 17` catch
  // whatever came before it greets someone at 02:00 with "good afternoon".
  if (hour < 5) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

/**
 * What to call the reader.
 *
 * The proxy sends a display name, a username and an email, and any of them can
 * be absent. First names only: "Good morning, Farhan" is a greeting, "Good
 * morning, farhan.helmy@…" is a mail merge. Returns null when nothing usable
 * arrived, and the greeting then stands on its own rather than addressing
 * someone called "there".
 */
export function firstName(profile: UserProfile | null): string | null {
  if (!profile) return null
  const named = profile.name?.trim() || profile.username?.trim()
  if (named) return named.split(/[\s._-]+/)[0] || null
  const local = profile.email?.split('@')[0]?.trim()
  if (!local) return null
  const first = local.split(/[._-]+/)[0]
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null
}
