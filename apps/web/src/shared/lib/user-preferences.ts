import type { Language } from '@/shared/lib/i18n'

export const PREFERENCES_STORAGE_KEY = 'pixelspace-preferences'

export type UserPreferences = {
  language: Language
  showToolTrace: boolean
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'en',
  showToolTrace: false,
}

export function parseStoredPreferences(raw: string | null): UserPreferences {
  if (!raw) return DEFAULT_PREFERENCES
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return {
      language: value.language === 'ms' ? 'ms' : 'en',
      showToolTrace: value.showToolTrace === true,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}
