import { useEffect, useState } from 'react'

/**
 * The current time, re-read on an interval.
 *
 * Aligned to the wall clock rather than to mount: a plain one-second interval
 * started at a random moment ticks at that moment's offset, so the displayed
 * second changes up to a second late and the minute rolls over visibly wrong.
 * Each tick schedules the next one at the top of the following second.
 */
export function useNow(stepMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const at = new Date()
      setNow(at)
      timer = setTimeout(tick, stepMs - (at.getTime() % stepMs))
    }
    timer = setTimeout(tick, stepMs - (Date.now() % stepMs))
    return () => clearTimeout(timer)
  }, [stepMs])

  return now
}
