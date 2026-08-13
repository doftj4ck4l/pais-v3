import { useCallback, useEffect, useState } from 'react'

const KEY = 'pixelspace-sidebar-open'

/**
 * Whether the sidebar is showing.
 *
 * Persisted, because it is a working preference rather than page state:
 * someone who closes it to read a long transcript should not have it reopen on
 * every reload. Open by default — the sidebar is how you reach everything, and
 * a console that starts with it hidden looks like it has one page.
 */
export function useSidebar() {
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(KEY) !== 'false')

  useEffect(() => {
    localStorage.setItem(KEY, String(open))
  }, [open])

  const toggle = useCallback(() => setOpen((v) => !v), [])
  return { open, setOpen, toggle }
}
