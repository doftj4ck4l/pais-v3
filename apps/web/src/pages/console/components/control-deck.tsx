import { PlusIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Separator } from '@/shared/ui/separator'
import { AgentList } from '@/features/agents/components/agent-list'
import { RunStats } from '@/features/agents/components/run-stats'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useCloseAside } from '@/features/navigation/lib/aside-context'
import { Brand } from '@/shared/components/brand'

/**
 * Which agents exist, which one is open, and how it went.
 *
 * This column has been emptied twice. It once carried the model and harness
 * pickers plus every resource panel — nine stacked sections in 288px, three
 * different kinds of thing sharing one space. Settings went behind the gear;
 * the resources became pages on the rail; the workspace picker and the account
 * became the head and foot of the rail itself. What is left is navigation
 * between agents, which is the only thing that was ever a sidebar.
 */
export function ControlDeck() {
  const board = useBoard()
  const closeAside = useCloseAside()

  const select = (id: string | null) => {
    board.select(id)
    closeAside()
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
        <Brand className="h-5 shrink-0" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="label text-muted-foreground">Agents</h2>
          <span className="readout text-[0.625rem] text-muted-foreground">
            {board.agents.length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => select(null)}
            aria-label="Start a new agent"
            className="ml-auto text-muted-foreground"
          >
            <PlusIcon />
          </Button>
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <AgentList
            meta={board.meta}
            agents={board.agents}
            selectedId={board.selectedId}
            onSelect={select}
            onRemove={board.remove}
          />
        </div>
      </div>

      {board.selected ? (
        <>
          <Separator />
          <div className="px-4 py-4">
            <h2 className="label mb-2 text-muted-foreground">This agent</h2>
            <RunStats agent={board.selected} />
          </div>
        </>
      ) : null}
    </div>
  )
}
