import { useCallback, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

const KEY = 'pixelspace-theme'
/** Newest first. Every rename leaves the old key readable, so an upgrade never
 *  resets a theme someone chose deliberately. */
const LEGACY_KEYS = ['salurai-theme', 'mixmatch-theme']

function stored(): string | null {
  for (const key of [KEY, ...LEGACY_KEYS]) {
    const value = localStorage.getItem(key)
    if (value) return value
  }
  return null
}

function initial(): Theme {
  const saved = stored()
  if (saved === 'light' || saved === 'dark') return saved
  // White is the house style; dark is opt-in.
  return 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    localStorage.setItem(KEY, theme)
  }, [theme])

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  return { theme, toggle }
}
