import { useCallback, useEffect, useState } from 'react'

const KEY = 'salurai-resources-open'
/** Below this the third column would squeeze the transcript, so it starts closed. */
const WIDE = 1280

/**
 * Open/closed state for the right-hand resources panel.
 *
 * Persisted because it is a workspace preference, not run state: someone who
 * keeps it closed to read transcripts should not have it reopen on every
 * reload. The default is width-dependent rather than fixed — on a laptop the
 * panel costs about a quarter of the rail, which is worth it only when there is
 * room to spare.
 */
export function useResourcePanel() {
  const [open, setOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(KEY)
    if (saved === 'true') return true
    if (saved === 'false') return false
    return window.innerWidth >= WIDE
  })

  useEffect(() => {
    localStorage.setItem(KEY, String(open))
  }, [open])

  const toggle = useCallback(() => setOpen((v) => !v), [])
  return { open, setOpen, toggle }
}
