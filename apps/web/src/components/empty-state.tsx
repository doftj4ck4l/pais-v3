import { ArrowRightIcon } from 'lucide-react'

export type Suggestion = { text: string; tool: string }

export function EmptyState({
  suggestions,
  onPick,
}: {
  suggestions: Suggestion[]
  onPick: (text: string) => void
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-12 sm:px-6">
      <h1 className="text-[clamp(1.9rem,4.5vw,2.6rem)] leading-[1.08] font-extrabold tracking-[-0.03em]">
        Run agents.
        <br />
        In parallel.
      </h1>

      <p className="mt-3 max-w-md text-[0.9375rem] text-muted-foreground">
        Every question starts its own agent. Watch them all from the sidebar.
      </p>

      <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            className="group flex items-center gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[0.9375rem] leading-snug font-semibold">{s.text}</span>
              <span className="readout mt-1.5 block text-muted-foreground">{s.tool}</span>
            </span>
            <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>

      <p className="mt-6 text-sm text-muted-foreground">Or type your own below.</p>
    </div>
  )
}
