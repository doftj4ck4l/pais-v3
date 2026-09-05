import { createContext, useContext } from 'react'
import type { Language, TranslationKey } from '@/shared/lib/i18n'
import type { UserPreferences } from '@/shared/lib/user-preferences'

export type PreferencesContextValue = UserPreferences & {
  setLanguage: (language: Language) => void
  setShowToolTrace: (show: boolean) => void
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
}

export const PreferencesContext = createContext<PreferencesContextValue | null>(null)

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext)
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider')
  return value
}
