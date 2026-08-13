import {
  BrainIcon,
  CloudIcon,
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
  // Next to Docs on purpose: a connector's files land in the same index as an
  // upload, so the two are two ways to fill one drawer.
  { to: '/sources', label: 'Sources', hint: 'Connected content sources', icon: CloudIcon },
  { to: '/data', label: 'Data', hint: 'Database connections', icon: DatabaseIcon },
  { to: '/mcp', label: 'MCP', hint: 'MCP servers and their tools', icon: PlugIcon },
  { to: '/files', label: 'Files', hint: 'Files the agent has written', icon: FileIcon },
  // Last, and the only page nothing is attached to: it fills itself.
  { to: '/learned', label: 'Learned', hint: 'What this workspace has learned', icon: BrainIcon },
]
