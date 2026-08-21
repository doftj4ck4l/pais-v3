import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { fetchMe } from '@/shared/api/api'
import type { UserProfile } from '@/shared/lib/types'

export type MeState = {
  me: UserProfile | null
  loading: boolean
  /** Accept the profile returned by a successful local sign-in. */
  signedIn: (profile: UserProfile) => void
  /** Re-read the profile, after settings has changed the display name. */
  refresh: () => void
}

/**
 * Who is signed in, according to the deployment's configured auth mode.
 *
 * A local sign-in can seed the profile directly. `refresh` remains available
 * for display-name changes and session state established outside this tab.
 */
export function useMeState(): MeState {
  const [me, setMe] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const initialLoad = useRef(true)

  useEffect(() => {
    let live = true
    if (initialLoad.current) setLoading(true)
    fetchMe()
      .then((profile) => {
        if (!live) return
        setMe(profile)
      })
      .catch(() => {
        if (!live) return
        setMe(null)
      })
      .finally(() => {
        if (!live) return
        initialLoad.current = false
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const signedIn = useCallback((profile: UserProfile) => setMe(profile), [])
  return { me, loading, signedIn, refresh }
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
