import type { ReactNode } from 'react'
import { PanelRightIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Separator } from '@/shared/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { AgentList } from '@/features/agents/components/agent-list'
import { RunStats } from '@/features/agents/components/run-stats'
import { UserBadge } from '@/features/workspace/components/user-badge'
import { WorkspaceSwitcher } from '@/features/workspace/components/workspace-switcher'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import type { AgentRun } from '@/features/agents/hooks/use-agent-board'
import type { Meta } from '@/shared/lib/types'
import { Brand } from '@/shared/components/brand'

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
  onOpenSettings: () => void
  onToggleResources: () => void
}) {
  const workspace = useWorkspace()

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <Wordmark onOpenSettings={onOpenSettings} />
      <WorkspaceSwitcher
        workspaces={workspace.workspaces}
        current={workspace.current}
        loading={workspace.loading}
        onSelect={workspace.setCurrent}
        onCreate={workspace.create}
      />

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

      <div className="flex shrink-0 items-center gap-1 border-t px-3 py-2.5">
        {/* Trace and Runs used to sit here. The row is being kept for the admin
            panel that is going where they were, so it stays a row rather than
            collapsing into the badge above. */}
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

      <UserBadge />
    </div>
  )
}

function Wordmark({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
      {/* The lockup carries its own mark, so the π badge that used to sit here
          would be a second one competing with it. */}
      <Brand className="h-5 shrink-0" />

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
