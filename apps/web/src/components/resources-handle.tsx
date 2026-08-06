import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The grab-tab that opens and closes the resources panel.
 *
 * It straddles the divider rather than living in a header. Two reasons: a
 * toggle sitting on the edge it moves says what it does without a label, and
 * the header row it used to share is now four tabs wide with nothing left to
 * give.
 *
 * Vertically centred, so it is in the same place whether the panel is open or
 * shut — a control that moves when you use it is one you have to hunt for
 * twice.
 */
export function ResourcesHandle({
  open,
  onToggle,
  /** Panel width, as a Tailwind `right-*` step. Must match the aside's width. */
  offsetClass = 'right-72',
}: {
  open: boolean
  onToggle: () => void
  offsetClass?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? 'Hide documents, databases and files' : 'Show documents, databases and files'}
      aria-expanded={open}
      className={cn(
        'absolute top-1/2 z-20 -translate-y-1/2',
        // Open: sit on the panel's left border, shifted half its own width so
        // the border runs through its middle. Closed: tuck against the window
        // edge, fully visible.
        open ? cn(offsetClass, 'translate-x-1/2') : 'right-0',
        'flex h-14 w-5 items-center justify-center rounded-md border bg-background',
        'text-muted-foreground shadow-sm transition-colors',
        'hover:bg-accent hover:text-foreground',
        'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
      )}
    >
      {open ? (
        <ChevronRightIcon className="size-3.5" />
      ) : (
        <ChevronLeftIcon className="size-3.5" />
      )}
    </button>
  )
}
