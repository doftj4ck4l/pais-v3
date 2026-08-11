import { useState } from 'react'
import { ArrowDownIcon, PanelLeftIcon, PanelRightIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/shared/ui/sheet'
import { AgentHeader } from '@/features/agents/components/agent-header'
import { Composer } from '@/features/agents/components/composer'
import { ControlDeck } from '@/pages/console/components/control-deck'
import { ResourcesPanel } from '@/features/resources/components/resources-panel'
import { ResourcesHandle } from '@/features/resources/components/resources-handle'
import { SettingsModal } from '@/pages/console/components/settings-modal'
import { EmptyState } from '@/pages/console/components/empty-state'
import { TraceSheet } from '@/features/agents/components/trace-sheet'
import { Transcript } from '@/features/agents/components/transcript'
import { WorkspaceOnboarding } from '@/features/workspace/components/workspace-onboarding'
import { useAgentBoard } from '@/features/agents/hooks/use-agent-board'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import { useStickToBottom } from '@/shared/hooks/use-stick-to-bottom'
import { useResourcePanel } from '@/features/resources/hooks/use-resource-panel'
import { useTheme } from '@/shared/hooks/use-theme'
import { cn } from '@/shared/lib/utils'
import { Brand } from '@/shared/components/brand'


export function Console() {
  // Provided by __root, so the open workspace survives navigating away to the
  // admin page and back.
  const workspace = useWorkspace()
  const board = useAgentBoard(workspace.scope)
  const { theme, toggle } = useTheme()
  const [deckOpen, setDeckOpen] = useState(false)
  const [traceOpen, setTraceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const panel = useResourcePanel()

  const { selected } = board
  // Keyed on the agent, so switching to another transcript starts at its end
  // rather than inheriting this one's scroll offset.
  const scroll = useStickToBottom<HTMLElement>(board.selectedId)
  const selectedModel = board.meta?.models.find((m) => m.id === selected?.modelId)

  /**
   * Sending continues the open agent; with nothing selected it starts one.
   *
   * The composer looks like a chat box, so it has to behave like one. Starting a
   * parallel agent stays available as an explicit action (the + in the deck),
   * which is what the board is for.
   */
  const send = (text: string) => {
    if (selected && selected.status !== 'running') board.sendFollowUp(selected.id, text)
    else board.spawn(text, board.modelIdForNew)
    setDeckOpen(false)
  }

  const spawn = (text: string) => {
    board.spawn(text, board.modelIdForNew)
    setDeckOpen(false)
  }

  const deck = (
    <ControlDeck
      meta={board.meta}
      agents={board.agents}
      selected={selected}
      selectedId={board.selectedId}
      onSelectAgent={(id) => {
        board.select(id)
        setDeckOpen(false)
      }}
      onRemoveAgent={board.remove}
      onNewAgent={() => {
        board.select(null)
        setDeckOpen(false)
      }}
      onOpenTrace={() => {
        setDeckOpen(false)
        setTraceOpen(true)
      }}
      onOpenSettings={() => {
        setDeckOpen(false)
        setSettingsOpen(true)
      }}
      onToggleResources={() => {
        setDeckOpen(false)
        panel.toggle()
      }}
    />
  )

  // Keyed on the workspace so switching remounts the panels: each holds its own
  // fetched rows, and re-rendering with a new scope would show the previous
  // workspace's documents until every request came back.
  const resources = (
    <ResourcesPanel key={workspace.current ?? 'none'} filesRefreshKey={board.runsCompleted} />
  )

  // Before any workspace exists there is nothing for the console to show and
  // nothing for an agent to act on, so onboarding replaces the whole screen
  // rather than appearing inside a shell full of disabled controls.
  if (workspace.needsOnboarding) {
    return <WorkspaceOnboarding onCreate={workspace.create} />
  }

  return (
    <>
    <div className="relative flex h-full">
      <aside className="hidden w-72 shrink-0 border-r lg:block">{deck}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-3 py-2.5 lg:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDeckOpen(true)}
            aria-label="Open agents"
          >
            <PanelLeftIcon />
          </Button>
          <Brand className="h-4 shrink-0" />
          <span className="readout ml-auto text-[0.6875rem] text-muted-foreground">
            {board.agents.length} agent{board.agents.length === 1 ? '' : 's'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={panel.toggle}
            aria-label="Toggle documents, databases and files"
          >
            <PanelRightIcon />
          </Button>
        </header>

        {selected ? (
          <AgentHeader
            agent={selected}
            model={selectedModel}
            onStop={() => board.stop(selected.id)}
            onToggleResources={panel.toggle}
          />
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <main ref={scroll.ref} className="min-h-0 flex-1 overflow-y-auto">
            {selected ? (
              <Transcript
                items={selected.items}
                running={selected.status === 'running'}
                runSummary={`Working… ${(selected.elapsed / 1000).toFixed(1)}s`}
              />
            ) : (
              <EmptyState harnessId={board.harnessId} onPick={spawn} />
            )}
          </main>

          {/* Only meaningful with a transcript to return to. */}
          {selected && !scroll.stuck ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => scroll.scrollToBottom()}
              aria-label="Scroll to the latest message"
              className={cn(
                'absolute bottom-3 left-1/2 -translate-x-1/2 gap-1.5 rounded-full',
                'border shadow-md',
              )}
            >
              <ArrowDownIcon className="size-3.5" />
              {selected.status === 'running' ? 'Following paused' : 'Latest'}
            </Button>
          ) : null}
        </div>

        <Composer
          notice={selected?.notice ?? null}
          onDismissNotice={() => selected && board.dismissNotice(selected.id)}
          onSend={send}
        />
      </div>

      {panel.isWide && panel.open ? (
        <aside className="w-72 shrink-0 border-l">{resources}</aside>
      ) : null}

      {/* Wide only. On narrow screens the panel is a Sheet, which brings its
          own close button and its own backdrop to dismiss through. */}
      {panel.isWide ? <ResourcesHandle open={panel.open} onToggle={panel.toggle} /> : null}
    </div>

    <Sheet open={deckOpen} onOpenChange={setDeckOpen}>
      <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
        <SheetTitle className="sr-only">Agents and settings</SheetTitle>
        {deck}
      </SheetContent>
    </Sheet>

    {/* Narrow only. A Sheet portals its own backdrop, so mounting it
        alongside the inline column would dim the page behind that column —
        hiding just its content with a CSS class is not enough. */}
    {!panel.isWide ? (
      <Sheet open={panel.open} onOpenChange={panel.setOpen}>
        <SheetContent side="right" className="w-80 gap-0 p-0 sm:max-w-80">
          <SheetTitle className="sr-only">Documents, databases and files</SheetTitle>
          {resources}
        </SheetContent>
      </Sheet>
    ) : null}

    <SettingsModal
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      meta={board.meta}
      harnessId={board.harnessId}
      onHarnessChange={board.setHarnessId}
      modelId={board.modelIdForNew}
      onModelChange={board.setModelIdForNew}
      agentCount={board.agents.length}
      onClearAll={board.clearAll}
      theme={theme}
      onToggleTheme={toggle}
    />

    <TraceSheet open={traceOpen} onOpenChange={setTraceOpen} trace={selected?.trace ?? []} />
    </>
  )
}
