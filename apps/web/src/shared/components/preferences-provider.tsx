import { useCallback, useEffect, useMemo, useState } from 'react'
import { PreferencesContext } from '@/shared/hooks/use-preferences'
import { translate, type Language, type TranslationKey } from '@/shared/lib/i18n'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  parseStoredPreferences,
  type UserPreferences,
} from '@/shared/lib/user-preferences'
import type { ReactNode } from 'react'

function initialPreferences(): UserPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES
  return parseStoredPreferences(window.localStorage.getItem(PREFERENCES_STORAGE_KEY))
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UserPreferences>(initialPreferences)

  useEffect(() => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
    document.documentElement.lang = preferences.language === 'ms' ? 'ms' : 'en'
  }, [preferences])

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === PREFERENCES_STORAGE_KEY) {
        setPreferences(parseStoredPreferences(event.newValue))
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const setLanguage = useCallback(
    (language: Language) => setPreferences((current) => ({ ...current, language })),
    [],
  )
  const setShowToolTrace = useCallback(
    (showToolTrace: boolean) => setPreferences((current) => ({ ...current, showToolTrace })),
    [],
  )
  const t = useCallback(
    (key: TranslationKey, values?: Record<string, string | number>) =>
      translate(preferences.language, key, values),
    [preferences.language],
  )
  const value = useMemo(
    () => ({ ...preferences, setLanguage, setShowToolTrace, t }),
    [preferences, setLanguage, setShowToolTrace, t],
  )

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}
