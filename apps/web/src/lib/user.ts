const KEY = 'mixmatch-user'

/**
 * A stable id for this browser, so stored conversations belong to whoever is
 * sitting here rather than to one shared bucket.
 */
export function getUserId(): string {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = `u_${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(KEY, id)
  }
  return id
}
