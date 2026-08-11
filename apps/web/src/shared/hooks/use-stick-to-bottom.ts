import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Follow streaming content, but yield the moment the reader scrolls away.
 *
 * The naive version — scroll to the end on every update — makes a running agent
 * impossible to read: any attempt to look back is undone by the next token. The
 * fix is to treat scroll position as the reader's intent rather than tracking a
 * separate "did they scroll" flag. Sitting at the bottom means following; moving
 * off it means reading, and returning to the bottom resumes following.
 *
 * That single rule also gets the tricky cases right for free. A programmatic
 * follow lands at the bottom, so it re-affirms the state it was already in. A
 * transcript shorter than its container is trivially "at the bottom", so the
 * jump button never shows up with nowhere to jump to.
 */

/**
 * How close to the end still counts as the end. Smooth scrolling and fractional
 * device pixels mean the arithmetic almost never lands on exactly zero, and a
 * strict check would drop the reader out of follow mode on the last pixel.
 */
const BOTTOM_THRESHOLD_PX = 48

export function useStickToBottom<T extends HTMLElement>(resetKey?: unknown) {
  const ref = useRef<T>(null)
  const [stuck, setStuck] = useState(true)

  const atBottom = (el: T) => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    // Set optimistically rather than waiting for the scroll event: a smooth
    // scroll reports its intermediate positions, and the button would otherwise
    // stay visible for the whole animation it was meant to end.
    setStuck(true)
  }, [])

  // Position is the source of truth for whether we are following.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => setStuck(atBottom(el))
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Deliberately no dependency array. Streaming mutates text inside an existing
  // item, so neither a length nor an identity check reliably changes — but React
  // has already re-rendered by the time this runs, which is exactly the signal
  // we need. `useLayoutEffect` keeps the correction in the same frame as the
  // paint, so following does not visibly judder.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !stuck) return
    // `auto`, not `smooth`: token-rate updates would queue animations faster
    // than they finish and the view would lag behind the text.
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
  })

  // Switching agents is a new document, not a continuation — start pinned to the
  // newest content rather than inheriting the previous transcript's offset.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    setStuck(true)
  }, [resetKey])

  return { ref, stuck, scrollToBottom }
}
