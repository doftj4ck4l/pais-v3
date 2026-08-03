import { useState } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentHeader } from '@/components/agent-header'
import { Composer } from '@/components/composer'
import { ControlDeck } from '@/components/control-deck'
import { EmptyState, type Suggestion } from '@/components/empty-state'
import { TraceSheet } from '@/components/trace-sheet'
import { Transcript } from '@/components/transcript'
import { useAgentBoard } from '@/hooks/use-agent-board'
import { useTheme } from '@/hooks/use-theme'

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

  const { selected } = board
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
      harnessId={board.harnessId}
      onHarnessChange={board.setHarnessId}
      modelId={board.modelIdForNew}
      onModelChange={board.setModelIdForNew}
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
      onClearAll={board.clearAll}
      theme={theme}
      onToggleTheme={toggle}
    />
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
            />
          ) : null}

          <main className="min-h-0 flex-1 overflow-y-auto">
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

          <Composer
            notice={selected?.notice ?? null}
            onDismissNotice={() => selected && board.dismissNotice(selected.id)}
            onSend={send}
          />
        </div>
      </div>

      <Sheet open={deckOpen} onOpenChange={setDeckOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
          <SheetTitle className="sr-only">Agents and settings</SheetTitle>
          {deck}
        </SheetContent>
      </Sheet>

      <TraceSheet open={traceOpen} onOpenChange={setTraceOpen} trace={selected?.trace ?? []} />
    </TooltipProvider>
  )
}
