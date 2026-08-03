import type { ReactNode } from 'react'
import { MoonIcon, PlusIcon, SunIcon, TerminalIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentList } from '@/components/agent-list'
import { DocumentPanel } from '@/components/document-panel'
import { FilesPanel } from '@/components/files-panel'
import { ModelLogo } from '@/components/model-logo'
import { RunStats } from '@/components/run-stats'
import type { AgentRun } from '@/hooks/use-agent-board'
import type { Meta } from '@/lib/types'

export function ControlDeck({
  meta,
  harnessId,
  onHarnessChange,
  modelId,
  onModelChange,
  agents,
  selected,
  selectedId,
  onSelectAgent,
  onRemoveAgent,
  onNewAgent,
  onOpenTrace,
  onClearAll,
  theme,
  onToggleTheme,
  filesRefreshKey,
}: {
  meta: Meta | null
  harnessId: string
  onHarnessChange: (id: string) => void
  modelId: string
  onModelChange: (id: string) => void
  agents: AgentRun[]
  selected: AgentRun | null
  selectedId: string | null
  onSelectAgent: (id: string) => void
  onRemoveAgent: (id: string) => void
  onNewAgent: () => void
  onOpenTrace: () => void
  onClearAll: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  /** Bumped when a run finishes, so produced files show up without a manual refresh. */
  filesRefreshKey?: number
}) {
  const model = meta?.models.find((m) => m.id === modelId)

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <Wordmark />

      <div className="flex flex-col gap-3 px-4 py-4">
        <Field label="Model">
          <Select value={modelId} onValueChange={onModelChange}>
            {/* No logo here: SelectValue already mirrors the chosen item's content. */}
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {meta?.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex items-center gap-2">
                      <ModelLogo model={m} size={16} className="rounded-[4px]" />
                      <span className="readout">{m.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {model && !model.ready ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Add an API key to use this model.
            </p>
          ) : null}
        </Field>

        <Field label="Harness">
          <Select value={harnessId} onValueChange={onHarnessChange}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {meta?.harnesses.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Separator />

      <div className="px-4 py-4">
        <DocumentPanel />
      </div>

      <Separator />

      <div className="px-4 py-4">
        <FilesPanel refreshKey={filesRefreshKey} />
      </div>

      <Separator />

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

        <div className="ml-auto flex items-center">
          <IconAction
            label="Remove all agents"
            onClick={onClearAll}
            disabled={agents.length === 0}
          >
            <Trash2Icon />
          </IconAction>
          <IconAction
            label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={onToggleTheme}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </IconAction>
        </div>
      </div>
    </div>
  )
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
        <span className="-mt-0.5 font-[family-name:var(--font-mono)] text-base leading-none">
          π
        </span>
      </span>
      <span className="text-[0.9375rem] font-extrabold tracking-[-0.02em]">SalurAI</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="label mb-1.5 text-muted-foreground">{label}</h2>
      {children}
    </div>
  )
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="text-muted-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
