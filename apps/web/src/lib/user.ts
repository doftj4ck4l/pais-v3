const KEY = 'salurai-user'
/** Pre-rebrand key. Read once so existing browsers keep their history. */
const LEGACY_KEY = 'mixmatch-user'

/**
 * A stable id for this browser, so stored conversations belong to whoever is
 * sitting here rather than to one shared bucket.
 *
 * This id owns everything the browser has stored — conversations, transcripts
 * and uploaded documents are all scoped by it. Minting a fresh one on rename
 * would leave all of that intact server-side but invisible, which reads as data
 * loss. The old key is therefore adopted when present.
 */
export function getUserId(): string {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = localStorage.getItem(LEGACY_KEY) ?? `u_${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(KEY, id)
  }
  return id
}
