import { memo, useEffect, useState } from 'react'
import { ChevronRightIcon, Clock3Icon, FileSpreadsheetIcon, WrenchIcon, XIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible'
import { visibleTranscriptItems } from '@/features/agents/lib/transcript'
import { liveRunStatus } from '@/features/agents/lib/live-run-status'
import { renderMarkdown } from '@/features/agents/lib/markdown'
import { parseMessage, hasUiBlock, validateSpec } from '@/features/agents/lib/ui-blocks'
import { SegmentView } from '@/features/agents/components/ui-blocks'
import {
  attachedImageUrls,
  attachedWorkspaceFiles,
  withoutAttachmentNote,
} from '@/features/agents/lib/attachment-notes'
import { cn } from '@/shared/lib/utils'
import { withAppBase } from '@/shared/lib/app-base'
import { usePreferences } from '@/shared/hooks/use-preferences'
import type { Item } from '@/shared/lib/types'
import type { TranscriptDisplayItem } from '@/features/agents/lib/transcript'
import type { QueuedFollowUp } from '@/features/agents/lib/follow-up-queue'
import type { LiveStatus } from '@/features/agents/lib/live-run-status'

/**
 * The transcript reads as a conversation: what the user asked, what the agent
 * said, and — while it is working — one quiet loading line. Reasoning stays
 * hidden. Tool calls and web searches are hidden by default, but a user can opt
 * into their exact execution details in Settings. `render_ui` stays visible in
 * either mode because its whole purpose is to draw something into the reply.
 */
export function Transcript({
  items,
  running,
  waitingForUser = false,
  showToolTrace = false,
  queuedFollowUps = [],
  onRemoveQueuedFollowUp,
}: {
  items: Item[]
  running: boolean
  waitingForUser?: boolean
  showToolTrace?: boolean
  queuedFollowUps?: QueuedFollowUp[]
  onRemoveQueuedFollowUp?: (id: string) => void
}) {
  const status = liveRunStatus(items, waitingForUser)
  // Scrolling is owned by the scroll container itself (see `useStickToBottom`),
  // not by this component. Following from in here would mean scrolling an
  // ancestor it does not own, and would override the reader unconditionally.
  return (
    // Top-aligned: the agent header anchors the top of this column, so the
    // transcript starts right under it rather than floating above the composer.
    <div className="mx-auto w-full max-w-3xl px-4 pt-7 pb-4 sm:px-6">
      <TranscriptBody items={items} running={running} showToolTrace={showToolTrace} />

      {running ? (
        // Left-aligned with the prose, not centred: this is the head of the
        // answer the model is about to write, so it belongs at the same margin
        // the answer will start from. Centred, it read as a separate thing
        // floating in the middle of the column. No elapsed timer beside it — the
        // sentence is the status, and a stopwatch next to a sentence that already
        // says what is happening is noise. Run stats still carry the duration.
        <div
          className="mt-4 mb-1 flex min-h-10 items-center text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <LiveStatusLabel status={status} />
        </div>
      ) : null}

      {queuedFollowUps.map((followUp, index) => (
        <QueuedMessage
          key={followUp.id}
          followUp={followUp}
          position={index + 1}
          onRemove={onRemoveQueuedFollowUp}
        />
      ))}
    </div>
  )
}

function LiveStatusLabel({ status }: { status: LiveStatus }) {
  const { t } = usePreferences()
  // Keyed on the rendered text, not the status key: reading one file and then
  // another keeps the same key but is a different sentence, and it should cross-fade
  // like any other change. Elapsed-time ticks live outside this, so they never
  // restart it.
  const label = t(status.key, status.values)
  const [labels, setLabels] = useState<{ current: string; previous: string | null }>({
    current: label,
    previous: null,
  })

  useEffect(() => {
    setLabels((value) =>
      value.current === label ? value : { current: label, previous: value.current },
    )

    const timeout = window.setTimeout(() => {
      setLabels((value) => ({ ...value, previous: null }))
    }, 280)

    return () => window.clearTimeout(timeout)
  }, [label])

  return (
    <span className="live-status-label text-[0.8125rem] font-medium">
      {labels.previous ? (
        <span key={`previous-${labels.previous}`} className="live-status-exit" aria-hidden="true">
          <span className="shimmer">{labels.previous}</span>
        </span>
      ) : null}
      <span key={labels.current} className="live-status-enter">
        <span className="shimmer">{labels.current}</span>
      </span>
    </span>
  )
}

function QueuedMessage({
  followUp,
  position,
  onRemove,
}: {
  followUp: QueuedFollowUp
  position: number
  onRemove?: (id: string) => void
}) {
  const { t } = usePreferences()
  const { images, dataFiles } = followUp.attachments

  return (
    <div className="mt-4 mb-2 flex justify-end">
      <div className="max-w-[85%] overflow-hidden rounded-[1.4rem] border border-dashed border-border bg-secondary/70 text-secondary-foreground sm:max-w-[75%]">
        <div className="px-4 pt-2.5 text-[0.9375rem] leading-relaxed">
          {images.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {images.map((image) => (
                <img
                  key={image.id}
                  src={image.url}
                  alt={image.name}
                  className="max-h-32 max-w-full rounded-xl border object-contain opacity-75"
                />
              ))}
            </div>
          ) : null}
          {dataFiles.length ? (
            <div className="mb-2 flex flex-col gap-1.5">
              {dataFiles.map((file) => (
                <span key={file.path} className="flex min-w-0 items-center gap-2 rounded-xl border bg-background/50 px-2.5 py-2">
                  <FileSpreadsheetIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs">{file.name}</span>
                </span>
              ))}
            </div>
          ) : null}
          <p className="whitespace-pre-wrap break-words">{followUp.text}</p>
        </div>
        <div className="mt-2 flex min-h-8 items-center gap-2 border-t border-border/70 px-3 text-[0.6875rem] text-muted-foreground">
          <Clock3Icon className="size-3.5" />
          <span>{t('queuedMessage', { position })}</span>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onRemove(followUp.id)}
              aria-label={t('removeQueuedMessage')}
              className="ml-auto rounded-full"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const TranscriptBody = memo(function TranscriptBody({
  items,
  running,
  showToolTrace,
}: {
  items: Item[]
  running: boolean
  showToolTrace: boolean
}) {
  // Reasoning draws no rows. Tool calls (web searches included) are admitted
  // only by the user's trace preference; conversation text and `render_ui`
  // output always remain.
  const visible = visibleTranscriptItems(items, showToolTrace)

  return visible.map((item, i) => (
    <TranscriptRow key={i} item={item} streaming={running && i === visible.length - 1} />
  ))
})

function TranscriptRow({ item, streaming }: { item: TranscriptDisplayItem; streaming: boolean }) {
  if (item.kind === 'user') {
    // A stored turn has no `images` — it comes back as the note the server
    // appended, so the URLs are recovered from the text. A live turn has both,
    // and the ids match, so this stays one code path rather than two.
    const attached = (item.images?.length ? item.images : attachedImageUrls(item.text)).map(withAppBase)
    const attachedFiles = (item.files?.length ? item.files : attachedWorkspaceFiles(item.text)).map((file) => ({
      ...file,
      url: withAppBase(file.url),
    }))
    return (
      // Flushed right, and the only thing in the transcript that is. The agent's
      // side of the conversation is prose — answers, code, lists, images — and
      // prose reads from one left margin; the question is short and needs no
      // margin of its own. Sides are what separate them, so neither needs a
      // "You"/"Assistant" label, and the answer keeps the full column width.
      //
      // Capped rather than full width: a bubble that reaches both edges has no
      // side to be on, and a pasted paragraph would look like the agent's own.
      <div className="mt-8 mb-6 flex justify-end first:mt-0">
        <div className="max-w-[85%] rounded-[1.4rem] bg-secondary px-4 py-2.5 text-[0.9375rem] leading-relaxed text-secondary-foreground sm:max-w-[75%]">
          {attached.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attached.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={url}
                    alt="Attached"
                    className="max-h-40 max-w-full rounded-xl border object-contain"
                  />
                </a>
              ))}
            </div>
          ) : null}
          {attachedFiles.length ? (
            <div className="mb-2 flex flex-col gap-1.5">
              {attachedFiles.map((file) => (
                <a
                  key={file.path}
                  href={file.url}
                  download
                  className="flex min-w-0 items-center gap-2 rounded-xl border bg-background/60 px-2.5 py-2 transition-colors hover:bg-background"
                >
                  <FileSpreadsheetIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs">{file.name}</span>
                </a>
              ))}
            </div>
          ) : null}
          <p className="whitespace-pre-wrap break-words">{withoutAttachmentNote(item.text)}</p>
        </div>
      </div>
    )
  }

  // `render_ui` is the one tool whose whole purpose is to draw something in the
  // answer, so it stays visible while every other tool is hidden — its call
  // arguments *are* the component, and they are rendered inline here.
  if (item.kind === 'tool') return <RenderUiLine item={item} />

  if (item.kind === 'tool-group') return <ToolActivityGroup tools={item.tools} />

  if (item.kind === 'assistant') return <AssistantMessage text={item.text} streaming={streaming} />
  return null
}

/**
 * Opt-in execution detail. One disclosure keeps the normal reading rhythm;
 * opening it reveals the exact machine-shaped payloads without truncating the
 * answer or inventing a friendlier meaning for an unfamiliar MCP tool.
 */
function ToolActivityGroup({ tools }: { tools: Array<Extract<Item, { kind: 'tool' }>> }) {
  const { t } = usePreferences()
  const pending = tools.some((tool) => tool.result === undefined)
  const failed = tools.filter((tool) => tool.ok === false).length
  const label = t('toolCalls', {
    count: tools.length,
    calls: t(tools.length === 1 ? 'callSingular' : 'callPlural'),
  })

  return (
    <div className="my-3 rounded-xl bg-muted/60">
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none">
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            {pending ? <Spinner className="size-3.5" /> : <WrenchIcon className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">{label}</span>
            <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
              {failed
                ? `${failed} ${t('toolFailed')}`
                : pending
                  ? t('toolRunning')
                  : t('toolComplete')}
            </span>
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="divide-y border-t border-border/70">
            {tools.map((tool) => (
              <ToolCallDetail key={tool.id} tool={tool} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ToolCallDetail({ tool }: { tool: Extract<Item, { kind: 'tool' }> }) {
  const { t } = usePreferences()
  const pending = tool.result === undefined
  const state = pending
    ? t('toolRunning')
    : tool.ok === false
      ? t('toolFailed')
      : t('toolComplete')

  return (
    <div className="px-3 py-3">
      <div className="flex items-baseline gap-2">
        <span className="readout min-w-0 flex-1 truncate font-medium">{tool.name}</span>
        <span className={cn('text-[0.6875rem] text-muted-foreground', tool.ok === false && 'text-destructive')}>
          {state}
        </span>
        {tool.ms !== undefined ? (
          <span className="readout text-[0.625rem] text-muted-foreground">
            {tool.ms >= 1000 ? `${(tool.ms / 1000).toFixed(1)}s` : `${tool.ms}ms`}
          </span>
        ) : null}
      </div>

      {tool.args !== '{}' ? (
        <Payload label={t('arguments')} value={tool.args} />
      ) : null}
      {!pending ? <Payload label={t('result')} value={tool.result ?? ''} /> : null}
    </div>
  )
}

function Payload({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 grid gap-1">
      <span className="label text-[0.625rem] text-muted-foreground">{label}</span>
      <pre className="readout max-h-64 overflow-auto rounded-md border bg-background px-2.5 py-2 leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
        {value}
      </pre>
    </div>
  )
}

/**
 * The agent's answer. Almost always one markdown blob, rendered exactly as
 * before — the fast path skips the segment split entirely. When the model has
 * emitted a ```ui block, the message becomes a sequence of prose and rendered
 * components instead, and the `caret` (streaming cursor) rides the last
 * markdown segment so it still trails the text rather than a chart.
 */
function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  if (!hasUiBlock(text)) {
    return (
      <div
        className={cn('prose-agent mb-7 max-w-none break-words', streaming && 'caret')}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
    )
  }

  const segments = parseMessage(text)
  const lastMarkdown = segments.reduce((at, s, i) => (s.kind === 'markdown' ? i : at), -1)

  return (
    <div className="mt-2 mb-6">
      {segments.map((segment, i) =>
        segment.kind === 'markdown' ? (
          <div
            key={i}
            className={cn(
              'prose-agent max-w-none break-words',
              streaming && i === lastMarkdown && 'caret',
            )}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(segment.text) }}
          />
        ) : (
          <SegmentView key={i} segment={segment} />
        ),
      )}
    </div>
  )
}

/**
 * A `render_ui` call, drawn as the component it describes rather than as a tool
 * line. The spec rides in the call arguments, so it renders the moment the call
 * is seen — the tool result only confirms server-side validation. A call the
 * server rejected (`ok === false`) means the model is about to retry with fixed
 * props; its failed attempt collapses to a quiet note rather than a broken box.
 */
function RenderUiLine({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const { t } = usePreferences()
  const spec = parseSpecFromArgs(item.args)

  if (item.ok === false || !spec) {
    // Pending (no result yet) with a valid-looking spec still shows the chart —
    // only a spec that will not parse waits. This keeps the common path instant.
    if (item.result === undefined && spec) return <SegmentView segment={{ kind: 'ui', spec }} />
    if (item.result === undefined) {
      return <div className="my-4 h-[260px] animate-pulse rounded-lg border bg-muted/30" aria-label={t('preparing')} />
    }
    return (
      <p className="my-2 text-xs text-muted-foreground/70 italic">{t('adjustingComponent')}</p>
    )
  }

  return <SegmentView segment={{ kind: 'ui', spec }} />
}

function parseSpecFromArgs(args: string) {
  try {
    return validateSpec(JSON.parse(args))
  } catch {
    return null
  }
}

/**
 * The note the server appends to a user message carrying attachments.
 *
 * It is written into the message text on purpose — that is how the model sees
 * it and how a reloaded conversation still knows an image was there. It is
 * addressed to the model, though, so the console hides it and draws the
 * pictures instead.
 */
