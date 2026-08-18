import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { fetchMe } from '@/shared/api/api'
import type { UserProfile } from '@/shared/lib/types'

export type MeState = {
  me: UserProfile | null
  loading: boolean
  /** Re-read the profile, after settings has changed the display name. */
  refresh: () => void
}

/**
 * Who is signed in, according to the proxy in front of this app.
 *
 * Fetched once: the identity cannot change without a new browser session,
 * because it is established before any request reaches the console. The one
 * thing that can change while the page is open is the display name, which is
 * ours rather than the provider's, and `refresh` is how settings says so.
 *
 * A failure here is not worth surfacing as an error. The console is reachable
 * at all only because the proxy already authenticated the request, so the
 * realistic causes are a dev server with no proxy in front of it or a session
 * that expired mid-page, and the next navigation lands on the login screen
 * anyway. Returning null lets the badge stay quiet rather than showing an
 * alarming error beside working software.
 */
export function useMeState(): MeState {
  const [me, setMe] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setLoading(true)
    fetchMe()
      .then((profile) => live && setMe(profile))
      .catch(() => live && setMe(null))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { me, loading, refresh }
}

/**
 * Shared rather than fetched per component, because the display name appears
 * in two places at once: the badge that opens settings, and the greeting
 * behind it. Two independent copies would leave the greeting showing the old
 * name until something else remounted it.
 */
export const MeContext = createContext<MeState | null>(null)

export function useMeContext(): MeState {
  const value = useContext(MeContext)
  if (!value) throw new Error('useMe must be used inside MeContext')
  return value
}

/** Just the profile, for the common case of a component only rendering it. */
export function useMe(): UserProfile | null {
  return useMeContext().me
}
