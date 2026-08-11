import { useState } from 'react'
import { BrainIcon, CloudIcon, DatabaseIcon, FileIcon, FileTextIcon, PlugIcon } from 'lucide-react'
import { DocumentPanel } from '@/features/resources/components/document-panel'
import { DatabasePanel } from '@/features/resources/components/database-panel'
import { FilesPanel } from '@/features/resources/components/files-panel'
import { McpPanel } from '@/features/resources/components/mcp-panel'
import { ConnectorPanel } from '@/features/resources/components/connector-panel'
import { PlaybookPanel } from '@/features/resources/components/playbook-panel'
import { cn } from '@/shared/lib/utils'

type TabId = 'documents' | 'connectors' | 'databases' | 'mcp' | 'files' | 'playbook'

const TABS: { id: TabId; label: string; icon: typeof FileTextIcon }[] = [
  { id: 'documents', label: 'Docs', icon: FileTextIcon },
  // Next to Docs on purpose: a connector's files land in the same index as an
  // upload, so the two tabs are two ways to fill one drawer.
  { id: 'connectors', label: 'Sources', icon: CloudIcon },
  { id: 'databases', label: 'Data', icon: DatabaseIcon },
  { id: 'mcp', label: 'MCP', icon: PlugIcon },
  { id: 'files', label: 'Files', icon: FileIcon },
  // Last, and the only tab nothing is attached to: it fills itself.
  { id: 'playbook', label: 'Learned', icon: BrainIcon },
]

/**
 * What the agent can reach: uploaded documents, connected databases, MCP
 * servers, and files it has produced.
 *
 * Tabbed rather than stacked because the list of source types grows — four
 * today, more later — and a sidebar that grows with it eventually pushes the
 * agent list off screen. Counts stay on the inactive tabs so switching is never
 * needed just to see whether something is attached.
 *
 * All four stay mounted. Each fetches on mount and on its own refresh, so
 * unmounting would re-fetch on every tab switch and lose the panels' local
 * state (a half-typed connection string, for one).
 */
export function ResourcesPanel({ filesRefreshKey }: { filesRefreshKey?: number }) {
  const [tab, setTab] = useState<TabId>('documents')
  const [counts, setCounts] = useState<Record<TabId, number>>({
    documents: 0,
    connectors: 0,
    databases: 0,
    mcp: 0,
    files: 0,
    playbook: 0,
  })

  const setCount = (id: TabId) => (n: number) =>
    setCounts((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }))

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/*
        A three-column grid, not a flex row.
        `flex-1` divided 288px between five tabs — about 51px each, when
        "Sources" alone needs ~72px with its icon and count. The labels did not
        shrink, they overflowed: MCP was clipped mid-word and Files was pushed
        off the panel entirely, unreachable.
        Fixed columns wrap instead of squeezing, so a sixth source type fills
        the empty cell and a seventh starts a row rather than stealing width
        from the other six. Every tab keeps its label — Docs, Sources and Files
        are all file-shaped ideas, and icons alone would not separate them.
      */}
      <div
        role="tablist"
        aria-label="Resources"
        className="grid grid-cols-3 gap-1 border-b px-2 py-2"
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            onClick={() => setTab(id)}
            aria-selected={tab === id}
            className={cn(
              'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
              'outline-none focus-visible:ring-[1.5px] focus-visible:ring-foreground/40',
              tab === id
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {/* Truncates rather than widening the cell: one long label must not
                change the column width the other tabs are measured against. */}
            <span className="truncate">{label}</span>
            {counts[id] ? (
              <span className="readout shrink-0 text-[0.625rem] opacity-70">{counts[id]}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Pane active={tab === 'documents'}>
          <DocumentPanel onCountChange={setCount('documents')} />
        </Pane>
        <Pane active={tab === 'connectors'}>
          <ConnectorPanel onCountChange={setCount('connectors')} />
        </Pane>
        <Pane active={tab === 'databases'}>
          <DatabasePanel onCountChange={setCount('databases')} />
        </Pane>
        <Pane active={tab === 'mcp'}>
          <McpPanel onCountChange={setCount('mcp')} />
        </Pane>
        <Pane active={tab === 'files'}>
          <FilesPanel refreshKey={filesRefreshKey} onCountChange={setCount('files')} />
        </Pane>
        <Pane active={tab === 'playbook'}>
          <PlaybookPanel onCountChange={setCount('playbook')} />
        </Pane>
      </div>
    </div>
  )
}

/** Hidden rather than unmounted, so each panel keeps its state and its data. */
function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div hidden={!active}>{children}</div>
}
