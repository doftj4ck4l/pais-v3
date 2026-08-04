import { useState } from 'react'
import { ArrowDownIcon, PanelLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentHeader } from '@/components/agent-header'
import { Composer } from '@/components/composer'
import { ControlDeck } from '@/components/control-deck'
import { ResourcesPanel } from '@/components/resources-panel'
import { SettingsModal } from '@/components/settings-modal'
import { EmptyState, type Suggestion } from '@/components/empty-state'
import { TraceSheet } from '@/components/trace-sheet'
import { Transcript } from '@/components/transcript'
import { useAgentBoard } from '@/hooks/use-agent-board'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { useResourcePanel } from '@/hooks/use-resource-panel'
import { useTheme } from '@/hooks/use-theme'
import { cn } from '@/lib/utils'

// Each one fires a real tool, so a new agent has something to show.
const SUGGESTIONS: Suggestion[] = [
  { text: 'What time is it in Kuala Lumpur?', tool: 'get_current_time' },
  { text: 'Compute (2 + 3) * 4 - 10', tool: 'calculator' },
  { text: "What's the weather in Penang?", tool: 'get_weather' },
  { text: 'Roll a number between 1 and 20', tool: 'random_number' },
]

export default function App() {
  const board = useAgentBoard()
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
    />
  )

  const resources = (
    <ResourcesPanel onClose={() => panel.setOpen(false)} filesRefreshKey={board.runsCompleted} />
  )

  return (
    <TooltipProvider>
      <div className="flex h-full">
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
            <span className="text-sm font-extrabold tracking-[-0.02em]">SalurAI</span>
            <span className="readout ml-auto text-[0.6875rem] text-muted-foreground">
              {board.agents.length} agent{board.agents.length === 1 ? '' : 's'}
            </span>
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
                <EmptyState suggestions={SUGGESTIONS} onPick={spawn} />
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

        {panel.open ? (
          <aside className="hidden w-72 shrink-0 border-l xl:block">{resources}</aside>
        ) : null}
      </div>

      <Sheet open={deckOpen} onOpenChange={setDeckOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
          <SheetTitle className="sr-only">Agents and settings</SheetTitle>
          {deck}
        </SheetContent>
      </Sheet>

      {/* Under xl the third column would leave no room to read, so the same
          panel opens as a sheet instead. */}
      <Sheet open={panel.open} onOpenChange={panel.setOpen}>
        <SheetContent side="right" className="w-80 gap-0 p-0 sm:max-w-80 xl:hidden">
          <SheetTitle className="sr-only">Documents, databases and files</SheetTitle>
          {resources}
        </SheetContent>
      </Sheet>

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
    </TooltipProvider>
  )
}
