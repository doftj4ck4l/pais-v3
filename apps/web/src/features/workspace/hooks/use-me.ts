import { useEffect, useState } from 'react'
import { fetchMe } from '@/shared/api/api'
import type { UserProfile } from '@/shared/lib/types'

/**
 * Who is signed in, according to the proxy in front of this app.
 *
 * Fetched once: the identity cannot change without a new browser session,
 * because it is established before any request reaches the console.
 *
 * A failure here is not worth surfacing as an error. The console is reachable
 * at all only because the proxy already authenticated the request, so the
 * realistic causes are a dev server with no proxy in front of it or a session
 * that expired mid-page — and the next navigation lands on the login screen
 * anyway. Returning null lets the badge stay quiet rather than showing an
 * alarming error beside working software.
 */
export function useMe(): UserProfile | null {
  const [me, setMe] = useState<UserProfile | null>(null)

  useEffect(() => {
    let live = true
    fetchMe()
      .then((profile) => live && setMe(profile))
      .catch(() => live && setMe(null))
    return () => {
      live = false
    }
  }, [])

  return me
}
