/** The path this console is mounted under. Keep in sync with `vite.config.ts`. */
export const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

/**
 * Prefix a root-relative app path exactly once.
 *
 * Absolute URLs (http, protocol-relative, data) are left alone, and a path
 * already under the base is returned unchanged so callers can compose safely.
 */
export function withAppBase(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path
  if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) return path
  return `${APP_BASE}${path}`
}
