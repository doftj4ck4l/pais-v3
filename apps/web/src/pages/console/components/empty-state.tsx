import { ArrowRightIcon } from 'lucide-react'
import { useMe } from '@/features/workspace/hooks/use-me'
import { useSuggestions } from '@/features/agents/hooks/use-suggestions'
import { useNow } from '@/shared/hooks/use-now'
import { firstName, partOfDay } from './greeting'

/**
 * The console with nothing open yet.
 *
 * It used to open with a slogan. A slogan is what a landing page needs; what a
 * console needs is to say where you are — so it now answers who is signed in
 * and what the time is, and only then offers something to run.
 *
 * Split in two because the composer sits between them: the greeting is above
 * the box you type in, the suggestions are under it, and the whole arrangement
 * is what collapses when the first question turns this into a transcript.
 */
export function Greeting() {
  const me = useMe()
  const name = firstName(me)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-5 sm:px-6">
      <Clock />

      <h1 className="mt-4 text-[clamp(1.9rem,4.5vw,2.6rem)] leading-[1.08] font-extrabold tracking-[-0.03em]">
        <Salutation />
        {name ? <span className="text-foreground">, {name}</span> : null}
      </h1>

      <p className="mt-3 max-w-lg text-[0.9375rem] text-muted-foreground">
        Every question starts its own agent. Watch them all from the sidebar.
      </p>
    </div>
  )
}

export function Suggestions({
  onPick,
}: {
  onPick: (text: string) => void
}) {
  const suggestions = useSuggestions()

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-1 pb-8 sm:px-6">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            className="group flex items-center gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[0.9375rem] leading-snug font-semibold">{s.text}</span>
              <span className="readout mt-1.5 block text-muted-foreground">{s.hint}</span>
            </span>
            <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * "Good morning" — with the part of the day carrying the wordmark's gradient.
 *
 * The one place brand colour appears on this screen, and it is on the only
 * word that changes. Everything else here is greyscale, which is what keeps a
 * gradient from reading as decoration.
 */
function Salutation() {
  const part = partOfDay(useNow(60_000))
  return (
    <>
      Good{' '}
      <span className="bg-gradient-to-r from-brand-from to-brand-to bg-clip-text text-transparent">
        {part}
      </span>
    </>
  )
}

/**
 * The time, seconds and all, above the greeting.
 *
 * Its own component so that a tick re-renders eleven characters rather than
 * the whole screen and its four buttons.
 *
 * Seconds are set at 40% — present, because a console that shows a frozen
 * HH:MM looks broken, but dimmed, because nothing here is worth reading to the
 * second. The zone is spelled out for the same reason the first suggestion
 * asks an agent what time it is in Kuala Lumpur: this clock is the one that is
 * yours, and the agent's is not.
 */
function Clock() {
  const now = useNow()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const hhmm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const ss = now.toLocaleTimeString([], { second: '2-digit' }).padStart(2, '0')
  const date = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })

  return (
    <div className="readout flex items-center gap-2.5 text-[0.8125rem] tracking-[0.01em] text-muted-foreground">
      <time dateTime={now.toISOString()}>
        {hhmm}
        <span className="opacity-40">:{ss}</span>
      </time>
      <span className="text-rail" aria-hidden>
        ·
      </span>
      <span>{date}</span>
      <span className="hidden text-rail sm:inline" aria-hidden>
        ·
      </span>
      <span className="hidden sm:inline">{zone.replace(/_/g, ' ')}</span>
    </div>
  )
}
