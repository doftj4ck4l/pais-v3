import type { ReactNode } from 'react'
import { PanelRightIcon, PlusIcon, SettingsIcon, TerminalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentList } from '@/components/agent-list'
import { RunStats } from '@/components/run-stats'
import type { AgentRun } from '@/hooks/use-agent-board'
import type { Meta } from '@/lib/types'

/**
 * Navigation and run inspection: which agents exist, which one is open, and how
 * it went.
 *
 * This also carried the model and harness pickers plus every resource panel —
 * nine stacked sections in a 288px column. Those were three different kinds of
 * thing sharing one space: configuration, resources the agent can reach, and
 * navigation. Only the last belongs in a sidebar. Settings moved behind the
 * gear; resources moved to the right-hand panel, where they can be tabbed as
 * source types keep being added.
 */
export function ControlDeck({
  meta,
  agents,
  selected,
  selectedId,
  onSelectAgent,
  onRemoveAgent,
  onNewAgent,
  onOpenTrace,
  onOpenSettings,
  onToggleResources,
}: {
  meta: Meta | null
  agents: AgentRun[]
  selected: AgentRun | null
  selectedId: string | null
  onSelectAgent: (id: string) => void
  onRemoveAgent: (id: string) => void
  onNewAgent: () => void
  onOpenTrace: () => void
  onOpenSettings: () => void
  onToggleResources: () => void
}) {
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <Wordmark onOpenSettings={onOpenSettings} />

      <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="label text-muted-foreground">Agents</h2>
          <span className="readout text-[0.625rem] text-muted-foreground">{agents.length}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNewAgent}
            aria-label="Start a new agent"
            className="ml-auto text-muted-foreground"
          >
            <PlusIcon />
          </Button>
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <AgentList
            meta={meta}
            agents={agents}
            selectedId={selectedId}
            onSelect={onSelectAgent}
            onRemove={onRemoveAgent}
          />
        </div>
      </div>

      {selected ? (
        <>
          <Separator />
          <div className="px-4 py-4">
            <h2 className="label mb-2 text-muted-foreground">This agent</h2>
            <RunStats agent={selected} />
          </div>
        </>
      ) : null}

      <div className="flex items-center gap-1 border-t px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenTrace}
          className="gap-1.5 text-muted-foreground"
        >
          <TerminalIcon data-icon="inline-start" />
          Trace
          <span className="readout text-[0.625rem] opacity-70">{selected?.trace.length ?? 0}</span>
        </Button>

        {/* Also on the agent header, but that only exists once a run is open —
            and attaching a database is something you do before any run. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleResources}
          className="ml-auto gap-1.5 text-muted-foreground"
        >
          <PanelRightIcon data-icon="inline-start" />
          Resources
        </Button>
      </div>
    </div>
  )
}

function Wordmark({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
        <span className="-mt-0.5 font-[family-name:var(--font-mono)] text-base leading-none">
          π
        </span>
      </span>
      <span className="text-[0.9375rem] font-extrabold tracking-[-0.02em]">SalurAI</span>

      <IconAction label="Settings" onClick={onOpenSettings}>
        <SettingsIcon />
      </IconAction>
    </div>
  )
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          className="ml-auto text-muted-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
