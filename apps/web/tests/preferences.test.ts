import { describe, expect, it } from 'bun:test'
import { parseStoredPreferences } from '../src/shared/lib/user-preferences'
import { localeFor, translate } from '../src/shared/lib/i18n'

describe('user preferences', () => {
  it('defaults to English with tool details hidden', () => {
    expect(parseStoredPreferences(null)).toEqual({ language: 'en', showToolTrace: false })
    expect(parseStoredPreferences('{bad json')).toEqual({ language: 'en', showToolTrace: false })
  })

  it('restores only supported persisted values', () => {
    expect(parseStoredPreferences(JSON.stringify({ language: 'ms', showToolTrace: true }))).toEqual({
      language: 'ms',
      showToolTrace: true,
    })
    expect(parseStoredPreferences(JSON.stringify({ language: 'fr', showToolTrace: 'yes' }))).toEqual({
      language: 'en',
      showToolTrace: false,
    })
  })

  it('translates Malay copy and interpolates values', () => {
    expect(translate('ms', 'settings')).toBe('Tetapan')
    expect(translate('ms', 'workingTime', { seconds: '4.2' })).toBe('Sedang bekerja… 4.2s')
    expect(localeFor('ms')).toBe('ms-MY')
  })
})
