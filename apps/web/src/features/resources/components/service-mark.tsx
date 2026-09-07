import { PlugIcon, TerminalIcon } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import type { Connector } from '@/features/resources/lib/connectors'

/**
 * What a connected service looks like before you read its name.
 *
 * The list used to open with a terminal glyph on every row, which is true of
 * all of them and therefore tells you nothing: five servers, five identical
 * marks, and the only way to find Nextcloud was to read five names. A service's
 * own colour is the thing people recognise without reading, so it carries the
 * tile — and it is the only colour on the card, which is what keeps a grid of
 * these from looking like a toy shelf.
 *
 * A server with no catalog match gets the same tile in the console's own
 * foreground colour rather than a fourth brand: it is a real state (someone
 * configured it by hand), not a failure to identify one.
 */

/** Brand marks, drawn rather than fetched — a remote logo is a request that fails offline. */
const MARKS: Record<string, (props: { className?: string }) => React.ReactElement> = {
  // Three rings: the large one flanked by two smaller, which is the shape of
  // the Nextcloud mark at the size a favicon renders it.
  nextcloud: ({ className }) => (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="3.4" cy="12" r="2.3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="20.6" cy="12" r="2.3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  ),
  // The offset block arrangement Plane uses as its app icon.
  plane: ({ className }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <rect x="2.5" y="2.5" width="8.5" height="8.5" rx="1.6" />
      <rect x="2.5" y="13" width="8.5" height="8.5" rx="1.6" />
      <rect x="13" y="13" width="8.5" height="8.5" rx="1.6" />
    </svg>
  ),
  // Microsoft's four squares, in Microsoft's four colours — the one mark here
  // that is exact, and the one people spot fastest.
  ms365: ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="2" y="2" width="9" height="9" fill="#F25022" />
      <rect x="13" y="2" width="9" height="9" fill="#7FBA00" />
      <rect x="2" y="13" width="9" height="9" fill="#00A4EF" />
      <rect x="13" y="13" width="9" height="9" fill="#FFB900" />
    </svg>
  ),
  // Odoo's leaf, simplified to a teardrop with a faint stem line.
  odoo: ({ className }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M4.5 19.5 C4.5 10.5 10.9 4.5 19.5 4.5 C19.5 13.5 13.1 19.5 4.5 19.5 Z" />
      <path
        d="M5 19 C8 15 11.5 11.5 15.5 8"
        stroke="rgba(255,255,255,.75)"
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  ),
}

/** The console's own foreground, for a server no catalog entry claims. */
const NEUTRAL_TINT = '148 163 184'

export function ServiceMark({
  connector,
  transport,
  size = 'md',
  className,
}: {
  /** The catalog entry this server matched, or null for a hand-configured one. */
  connector: Connector | null
  transport: 'http' | 'stdio'
  size?: 'sm' | 'md'
  className?: string
}) {
  const Mark = connector ? MARKS[connector.id] : undefined
  const Fallback = transport === 'stdio' ? TerminalIcon : PlugIcon
  const tint = connector?.tint ?? NEUTRAL_TINT

  return (
    <span
      aria-hidden
      style={{
        // Tailwind cannot name a colour it has never seen, and these come from
        // the catalog at runtime. The wash and the hairline are one value so a
        // service added later needs exactly one hex.
        backgroundColor: `rgb(${tint} / 0.14)`,
        boxShadow: `inset 0 0 0 1px rgb(${tint} / 0.3)`,
        color: `rgb(${tint})`,
      }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        size === 'sm' ? 'size-7' : 'size-9',
        className,
      )}
    >
      {Mark ? (
        <Mark className={size === 'sm' ? 'size-3.5' : 'size-[1.125rem]'} />
      ) : (
        <Fallback className={size === 'sm' ? 'size-3.5' : 'size-4'} strokeWidth={1.75} />
      )}
    </span>
  )
}

/** What to call a server's kind on the face of a card. */
export function serviceLabel(
  connector: Connector | null,
  transport: 'http' | 'stdio',
): string {
  if (connector) return connector.name
  return transport === 'stdio' ? 'Local process' : 'Remote server'
}
