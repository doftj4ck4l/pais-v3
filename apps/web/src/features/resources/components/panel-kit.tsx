import { Spinner } from '@/shared/ui/spinner'
import { cn } from '@/shared/lib/utils'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The two shapes every resource page is made of.
 *
 * They exist because the panels each grew their own: a full-width dashed bar
 * that said "Connect a read-only database". In a 288px drawer that bar was the
 * panel; stretched across a page it is a thousand pixels of dotted outline
 * around four words, inside a card that already has a border of its own.
 *
 * What replaces it is the arrangement every console settles on — Linear,
 * Vercel, Stripe: when there is nothing, say what this is for and offer one
 * button; when there is something, the button is a small one above the list,
 * and the list is the page.
 */
export function PanelHeader({
  summary,
  busy = false,
  action,
}: {
  /** Counts, in the readout face. Null when there is nothing to count. */
  summary?: ReactNode
  busy?: boolean
  action?: ReactNode
}) {
  if (!summary && !busy && !action) return null

  return (
    <div className="mb-3 flex min-h-8 items-center gap-2">
      {summary ? <span className="readout text-muted-foreground">{summary}</span> : null}
      {busy ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
      {action ? <div className="ml-auto flex items-center gap-2">{action}</div> : null}
    </div>
  )
}

/** Everything a page lists, as cards. One column on a phone, three on a desk. */
export function PanelGrid({ children }: { children: ReactNode }) {
  return <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
}

/**
 * One thing in that grid: a document, a database, a file, a source.
 *
 * Row controls are revealed on hover, which is the convention, but they are
 * also revealed on focus — a keyboard has no hover, and a delete button that
 * can be tabbed to while invisible is worse than one that is always shown.
 */
export function ItemCard({
  leading,
  title,
  meta,
  actions,
  /** Makes the whole card the link. Used by files, which are downloads. */
  href,
  download = false,
  label,
}: {
  leading?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  href?: string
  download?: boolean
  label?: string
}) {
  return (
    <li className="group relative flex flex-col gap-1.5 rounded-lg border bg-card p-3.5 transition-colors hover:border-foreground/25">
      {href ? (
        <a
          href={href}
          download={download}
          aria-label={label}
          className="absolute inset-0 rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        />
      ) : null}

      <div className="flex items-start gap-2">
        {leading}
        <span className="min-w-0 flex-1 text-sm leading-snug font-medium break-words">{title}</span>
        {actions ? (
          <span className="relative z-10 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {actions}
          </span>
        ) : null}
      </div>

      {meta ? <div className="readout text-muted-foreground">{meta}</div> : null}
    </li>
  )
}

export function PanelEmpty({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  /** What is missing, as a statement: "No databases connected". */
  title: string
  /** One sentence on what having one would do for you. */
  description: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-xl border bg-card px-6 py-16 text-center',
        className,
      )}
    >
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground"
      >
        <Icon className="size-5" />
      </span>

      <div className="space-y-1.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>

      {action}
    </div>
  )
}
