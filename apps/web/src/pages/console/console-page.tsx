import { ArrowDownIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { AgentHeader } from '@/features/agents/components/agent-header'
import { AppShell } from '@/features/navigation/components/app-shell'
import { Composer } from '@/features/agents/components/composer'
import { Greeting, Suggestions } from '@/pages/console/components/empty-state'
import type { UploadedImage } from '@/shared/lib/types'
import { Transcript } from '@/features/agents/components/transcript'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useStickToBottom } from '@/shared/hooks/use-stick-to-bottom'
import { cn } from '@/shared/lib/utils'

export function Console() {
  // Provided by __root, so an open agent and its live stream survive a trip to
  // any other page in the sidebar.
  const board = useBoard()

  const { selected } = board
  // Keyed on the agent, so switching to another transcript starts at its end
  // rather than inheriting this one's scroll offset.
  const scroll = useStickToBottom<HTMLElement>(board.selectedId)
  const selectedModel = board.meta?.models.find((m) => m.id === selected?.modelId)

  /**
   * Nothing open yet: the question is the whole page, so it sits in the middle
   * with the greeting above it and something to try below. Asking it fills the
   * row above with a transcript and empties the row below, which is what walks
   * the composer down to the foot of the window.
   */
  const waiting = !selected

  /**
   * Sending continues the open agent; with nothing selected it starts one.
   *
   * The composer looks like a chat box, so it has to behave like one. Starting a
   * parallel agent stays available as an explicit action (New agent in the
   * sidebar), which is what the board is for.
   */
  const send = (text: string, images: UploadedImage[] = []) => {
    if (selected && selected.status !== 'running') board.sendFollowUp(selected.id, text, images)
    else board.spawn(text, board.modelIdForNew, images)
  }

  return (
    <AppShell>
      {selected ? (
        <AgentHeader
          agent={selected}
          model={selectedModel}
          onStop={() => board.stop(selected.id)}
        />
      ) : null}

      {/*
        Three rows, and the animation is the middle one moving between them:
        `fr` units interpolate, so the transcript row growing from nothing while
        the suggestions row shrinks to nothing carries the composer down the
        window without measuring or positioning anything.
      */}
      <div
        className={cn(
          'grid min-h-0 flex-1 transition-[grid-template-rows] duration-500 ease-out',
          'motion-reduce:transition-none',
          waiting ? 'grid-rows-[1fr_auto_1fr]' : 'grid-rows-[1fr_auto_0fr]',
        )}
      >
        <div className="relative flex min-h-0 flex-col justify-end overflow-hidden">
          <main ref={scroll.ref} className="min-h-0 overflow-y-auto">
            {selected ? (
              <Transcript
                items={selected.items}
                running={selected.status === 'running'}
                runSummary={`Working… ${(selected.elapsed / 1000).toFixed(1)}s`}
              />
            ) : (
              <Greeting />
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
          docked={!waiting}
          notice={selected?.notice ?? null}
          onDismissNotice={() => selected && board.dismissNotice(selected.id)}
          onSend={send}
        />

        <div className="min-h-0 overflow-hidden">
          {waiting ? (
            <Suggestions
              harnessId={board.harnessId}
              onPick={(text) => board.spawn(text, board.modelIdForNew)}
            />
          ) : null}
        </div>
      </div>
    </AppShell>
  )
}
