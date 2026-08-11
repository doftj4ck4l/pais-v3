import { useCallback, useEffect, useState } from 'react'

const KEY = 'pixelspace-resources-open'
/** Read-only fallback; writes go to KEY. */
const LEGACY_KEY = 'salurai-resources-open'
/** Matches the `xl` breakpoint the inline column uses. */
const WIDE = '(min-width: 1280px)'

/**
 * Open/closed state for the right-hand resources panel, and whether the viewport
 * is wide enough to show it as a column rather than a sheet.
 *
 * `isWide` is a real media query rather than a CSS class because the two
 * presentations cannot both be mounted: a Sheet portals its own backdrop, so
 * hiding only its content with `xl:hidden` still dims the whole page behind the
 * inline column. The caller has to render one or the other.
 *
 * Open/closed is persisted because it is a workspace preference, not run state:
 * someone who keeps it closed to read transcripts should not have it reopen on
 * every reload. The initial default is width-dependent — the panel costs about a
 * quarter of the rail, which is only worth it when there is room to spare.
 */
export function useResourcePanel() {
  const [isWide, setIsWide] = useState(() => window.matchMedia(WIDE).matches)

  const [open, setOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (saved === 'true') return true
    if (saved === 'false') return false
    return window.matchMedia(WIDE).matches
  })

  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const onChange = (e: MediaQueryListEvent) => setIsWide(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    localStorage.setItem(KEY, String(open))
  }, [open])

  const toggle = useCallback(() => setOpen((v) => !v), [])
  return { open, setOpen, toggle, isWide }
}
