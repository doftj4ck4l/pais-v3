import {
  BrainIcon,
  BotIcon,
  DatabaseIcon,
  FileIcon,
  FileTextIcon,
  MessageSquareIcon,
  MicIcon,
  PlugIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TranslationKey } from '@/shared/lib/i18n'

/**
 * The console's destinations, in the order they appear in the sidebar.
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
  label: TranslationKey
  /** A short explanation available to surfaces that need more than the label. */
  hint: TranslationKey
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'chat', hint: 'navChatHint', icon: MessageSquareIcon },
  { to: '/agents', label: 'agents', hint: 'navAgentsHint', icon: BotIcon },
  { to: '/docs', label: 'docs', hint: 'navDocsHint', icon: FileTextIcon },
  { to: '/transcriptions', label: 'transcriptions', hint: 'navTranscriptionsHint', icon: MicIcon },
  // Sources is deliberately absent, not deleted: connectors are unfinished, and
  // a destination that half works is worse than one that is not offered yet.
  // The route and its panel are still here — put the entry back to restore it.
  { to: '/data', label: 'data', hint: 'navDataHint', icon: DatabaseIcon },
  // Labelled for what it does, not for the protocol that does it. "MCP" names
  // a wire format; what the reader is choosing is which of their own services
  // the agent can reach. The route, the tables and the code stay MCP — that is
  // the accurate name for the thing being spoken.
  { to: '/connectors', label: 'connectors', hint: 'navConnectorsHint', icon: PlugIcon },
  // The route stays `/files`: it is in links and bookmarks, and the label is
  // what anyone actually reads. "Assets" because the page holds pictures as
  // well as documents, and because the chat's own panel is the per-session view.
  { to: '/files', label: 'assets', hint: 'navAssetsHint', icon: FileIcon },
  // Last, and the only page nothing is attached to: it fills itself.
  { to: '/learned', label: 'learned', hint: 'navLearnedHint', icon: BrainIcon },
]
