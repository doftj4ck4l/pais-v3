import {
  BrainIcon,
  DatabaseIcon,
  FileIcon,
  FileTextIcon,
  MessageSquareIcon,
  PlugIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The console's destinations, in the order they appear on the rail.
 *
 * Each of these was a tab in the right-hand panel, which meant every source
 * type competed for one 288px column and none of them could ever be more than
 * a list. They are pages now: the rail says what exists, and each page has the
 * room its own content needs.
 *
 * Chat leads because it is what the console is for; everything below it is
 * something the agent can reach.
 */
export type NavItem = {
  to: string
  label: string
  /** What the page is, for the tooltip — the rail itself is icons only. */
  hint: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Chat', hint: 'Agents and transcripts', icon: MessageSquareIcon },
  { to: '/docs', label: 'Docs', hint: 'Uploaded documents', icon: FileTextIcon },
  // Sources is deliberately absent, not deleted: connectors are unfinished, and
  // a destination that half works is worse than one that is not offered yet.
  // The route and its panel are still here — put the entry back to restore it.
  { to: '/data', label: 'Data', hint: 'Database connections', icon: DatabaseIcon },
  // Labelled for what it does, not for the protocol that does it. "MCP" names
  // a wire format; what the reader is choosing is which of their own services
  // the agent can reach. The route, the tables and the code stay MCP — that is
  // the accurate name for the thing being spoken.
  { to: '/mcp', label: 'Connectors', hint: 'Services the agent can use', icon: PlugIcon },
  // The route stays `/files`: it is in links and bookmarks, and the label is
  // what anyone actually reads. "Assets" because the page holds pictures as
  // well as documents, and because the chat's own panel is the per-session view.
  { to: '/files', label: 'Assets', hint: 'Everything the agent has written', icon: FileIcon },
  // Last, and the only page nothing is attached to: it fills itself.
  { to: '/learned', label: 'Learned', hint: 'What this workspace has learned', icon: BrainIcon },
]
