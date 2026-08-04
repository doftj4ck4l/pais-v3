import { useState } from 'react'
import { DatabaseIcon, FileIcon, FileTextIcon, PanelRightCloseIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DocumentPanel } from '@/components/document-panel'
import { DatabasePanel } from '@/components/database-panel'
import { FilesPanel } from '@/components/files-panel'
import { cn } from '@/lib/utils'

type TabId = 'documents' | 'databases' | 'files'

const TABS: { id: TabId; label: string; icon: typeof FileTextIcon }[] = [
  { id: 'documents', label: 'Docs', icon: FileTextIcon },
  { id: 'databases', label: 'Data', icon: DatabaseIcon },
  { id: 'files', label: 'Files', icon: FileIcon },
]

/**
 * What the agent can reach: uploaded documents, connected databases, and files
 * it has produced.
 *
 * Tabbed rather than stacked because the list of source types grows — three
 * today, more later — and a sidebar that grows with it eventually pushes the
 * agent list off screen. Counts stay on the inactive tabs so switching is never
 * needed just to see whether something is attached.
 *
 * All three stay mounted. Each fetches on mount and on its own refresh, so
 * unmounting would re-fetch on every tab switch and lose the panels' local
 * state (a half-typed connection string, for one).
 */
export function ResourcesPanel({ onClose, filesRefreshKey }: {
  onClose: () => void
  filesRefreshKey?: number
}) {
  const [tab, setTab] = useState<TabId>('documents')
  const [counts, setCounts] = useState<Record<TabId, number>>({
    documents: 0,
    databases: 0,
    files: 0,
  })

  const setCount = (id: TabId) => (n: number) =>
    setCounts((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }))

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-1 border-b px-2 py-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
              tab === id
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {label}
            {counts[id] ? (
              <span className="readout text-[0.625rem] opacity-70">{counts[id]}</span>
            ) : null}
          </button>
        ))}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Hide resources"
          className="shrink-0 text-muted-foreground"
        >
          <PanelRightCloseIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Pane active={tab === 'documents'}>
          <DocumentPanel onCountChange={setCount('documents')} />
        </Pane>
        <Pane active={tab === 'databases'}>
          <DatabasePanel onCountChange={setCount('databases')} />
        </Pane>
        <Pane active={tab === 'files'}>
          <FilesPanel refreshKey={filesRefreshKey} onCountChange={setCount('files')} />
        </Pane>
      </div>
    </div>
  )
}

/** Hidden rather than unmounted, so each panel keeps its state and its data. */
function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div hidden={!active}>{children}</div>
}
