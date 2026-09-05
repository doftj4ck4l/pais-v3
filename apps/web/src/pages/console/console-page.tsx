import { useEffect, useState } from 'react'
import { ArrowDownIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/shared/ui/sheet'
import { AgentHeader } from '@/features/agents/components/agent-header'
import { AppShell } from '@/features/navigation/components/app-shell'
import { ArtifactPanel } from '@/features/agents/components/artifact-panel'
import { Composer } from '@/features/agents/components/composer'
import { AskUserPrompt } from '@/features/agents/components/ask-user-prompt'
import { Greeting, Suggestions } from '@/pages/console/components/empty-state'
import type { ChatAttachments } from '@/shared/lib/types'
import { Transcript } from '@/features/agents/components/transcript'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useSessionArtifacts } from '@/features/agents/hooks/use-session-artifacts'
import { useStickToBottom } from '@/shared/hooks/use-stick-to-bottom'
import { cn } from '@/shared/lib/utils'
import { usePreferences } from '@/shared/hooks/use-preferences'

export function Console() {
  // Provided by __root, so an open agent and its live stream survive a trip to
  // any other page in the sidebar.
  const board = useBoard()
  const { showToolTrace, t } = usePreferences()

  const { selected } = board
  // Keyed on the agent, so switching to another transcript starts at its end
  // rather than inheriting this one's scroll offset.
  const scroll = useStickToBottom<HTMLElement>(board.selectedId)
  const selectedModel = board.meta?.models.find((m) => m.id === selected?.modelId)

  // What this chat has produced. It follows the transcript as the run streams,
  // so a picture appears the moment the tool call returns.
  const artifacts = useSessionArtifacts(selected ?? null)
  const artifactCount = artifacts.count

  /**
   * The panel opens itself the first time a chat produces something, and stays
   * shut afterwards if you close it.
   *
   * Auto-opening is the whole reason a file belongs beside the transcript: the
   * failure this replaces was an agent finishing a spreadsheet and the user
   * having no reason to think a second page now had it. Closing is remembered
   * per chat rather than globally — dismissing it on one conversation should
   * not hide the next one's work.
   */
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})
  const [sheetOpen, setSheetOpen] = useState(false)
  const openId = board.selectedId
  const panelOpen = artifactCount > 0 && !!openId && !dismissed[openId]

  // A different chat starts with its panel un-dismissed, and its sheet closed:
  // a sheet left open over a transcript with nothing to show is a dead overlay.
  useEffect(() => setSheetOpen(false), [openId])

  const toggleArtifacts = () => {
    if (!openId) return
    if (isWide()) setDismissed((prev) => ({ ...prev, [openId]: !prev[openId] }))
    else setSheetOpen((open) => !open)
  }

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
  const send = (text: string, attachments: ChatAttachments) => {
    if (selected && selected.status !== 'running') {
      board.sendFollowUp(selected.id, text, attachments)
    } else board.spawn(text, board.modelIdForNew, attachments)
  }

  return (
    <AppShell>
      {/*
        The chat and its files, side by side. The panel is a column here rather
        than a page of its own because a file the agent made is part of the
        answer — putting it one navigation away is what made a finished run
        look like it had produced nothing.
      */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <AgentHeader
              agent={selected}
              model={selectedModel}
              onStop={() => board.stop(selected.id)}
              artifactCount={artifactCount}
              onToggleArtifacts={toggleArtifacts}
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
                    runSummary={t('workingTime', {
                      seconds: (selected.elapsed / 1000).toFixed(1),
                    })}
                    showToolTrace={showToolTrace}
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
                  aria-label={t('scrollLatest')}
                  className={cn(
                    'absolute bottom-3 left-1/2 -translate-x-1/2 gap-1.5 rounded-full',
                    'border shadow-md',
                  )}
                >
                  <ArrowDownIcon className="size-3.5" />
                  {selected.status === 'running' ? t('followingPaused') : t('latest')}
                </Button>
              ) : null}
            </div>

            {selected?.pendingQuestion ? (
              <AskUserPrompt
                question={selected.pendingQuestion}
                onAnswer={(text) => board.answer(selected.id, text)}
              />
            ) : null}

            <Composer
              docked={!waiting}
              notice={selected?.notice ?? null}
              conversationId={selected?.conversationId ?? null}
              onDismissNotice={() => selected && board.dismissNotice(selected.id)}
              onSend={send}
              models={board.meta?.models ?? []}
              modelId={board.modelIdForNew}
              onModelChange={board.setModelIdForNew}
              lockedModelId={selected?.modelId ?? null}
              effort={board.effort}
              onEffortChange={board.setEffort}
            />

            <div className="min-h-0 overflow-hidden">
              {waiting ? (
                <Suggestions
                  onPick={(text) => board.spawn(text, board.modelIdForNew)}
                />
              ) : null}
            </div>
          </div>
        </div>

        {/* Animated by width, like the sidebar: the transcript reflows into the
            space rather than the page jumping when a run produces its first file. */}
        <aside
          className={cn(
            'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-out lg:block',
            'motion-reduce:transition-none',
            panelOpen ? 'w-80 border-l xl:w-96' : 'w-0',
          )}
        >
          <div className="h-full w-80 xl:w-96">
            <ArtifactPanel
              artifacts={artifacts}
              onClose={() => openId && setDismissed((prev) => ({ ...prev, [openId]: true }))}
            />
          </div>
        </aside>
      </div>

      {/* Below `lg` there is no room for a second column, so the same panel is
          a sheet — reached from the header's count, never opened on its own. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-80 gap-0 p-0 sm:max-w-80">
          <SheetTitle className="sr-only">{t('filesInChat')}</SheetTitle>
          <ArtifactPanel
            artifacts={artifacts}
            onClose={() => setSheetOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </AppShell>
  )
}

/** Matches the `lg` breakpoint the panel column uses. */
function isWide(): boolean {
  return window.matchMedia('(min-width: 1024px)').matches
}
