import { memo } from 'react'
import { FileSpreadsheetIcon } from 'lucide-react'
import { Spinner } from '@/shared/ui/spinner'
import { groupTranscriptItems } from '@/features/agents/lib/transcript'
import { renderMarkdown } from '@/features/agents/lib/markdown'
import { parseMessage, hasUiBlock, validateSpec } from '@/features/agents/lib/ui-blocks'
import { SegmentView } from '@/features/agents/components/ui-blocks'
import {
  attachedImageUrls,
  attachedWorkspaceFiles,
  withoutAttachmentNote,
} from '@/features/agents/lib/attachment-notes'
import { cn } from '@/shared/lib/utils'
import type { Item } from '@/shared/lib/types'
import type { TranscriptDisplayItem } from '@/features/agents/lib/transcript'

/**
 * The transcript reads as a conversation: what the user asked, what the agent
 * said, and — while it is working — one quiet loading line. Reasoning, tool
 * calls, and web searches are deliberately hidden: they are the machinery, not
 * the answer, and readers follow the answer. `render_ui` is the one tool left
 * visible because its whole purpose is to draw something into the reply.
 */
export function Transcript({
  items,
  running,
  runSummary,
}: {
  items: Item[]
  running: boolean
  runSummary: string | null
}) {
  // Scrolling is owned by the scroll container itself (see `useStickToBottom`),
  // not by this component. Following from in here would mean scrolling an
  // ancestor it does not own, and would override the reader unconditionally.
  return (
    // Top-aligned: the agent header anchors the top of this column, so the
    // transcript starts right under it rather than floating above the composer.
    <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-4 sm:px-6">
      <TranscriptBody items={items} running={running} />

      {running ? (
        <div
          className="mt-4 mb-1 flex min-h-10 items-center justify-center gap-2.5 text-muted-foreground"
          role="status"
        >
          <Spinner className="size-4" />
          <span className="shimmer text-[0.8125rem] font-medium">
            {runSummary ?? 'Working…'}
          </span>
        </div>
      ) : null}
    </div>
  )
}

const TranscriptBody = memo(function TranscriptBody({
  items,
  running,
}: {
  items: Item[]
  running: boolean
}) {
  // Reasoning and working tool calls (web searches included) draw no rows at
  // all. Only the text of the conversation and `render_ui` output remain.
  const visible = groupTranscriptItems(
    items.filter(
      (item) =>
        item.kind === 'user' ||
        item.kind === 'assistant' ||
        (item.kind === 'tool' && item.name === 'render_ui'),
    ),
  )

  return visible.map((item, i) => (
    <TranscriptRow key={i} item={item} streaming={running && i === visible.length - 1} />
  ))
})

function TranscriptRow({ item, streaming }: { item: TranscriptDisplayItem; streaming: boolean }) {
  if (item.kind === 'user') {
    // A stored turn has no `images` — it comes back as the note the server
    // appended, so the URLs are recovered from the text. A live turn has both,
    // and the ids match, so this stays one code path rather than two.
    const attached = item.images?.length ? item.images : attachedImageUrls(item.text)
    const attachedFiles = item.files?.length ? item.files : attachedWorkspaceFiles(item.text)
    return (
      // Flushed right, and the only thing in the transcript that is. The agent's
      // side of the conversation is prose — answers, code, lists, images — and
      // prose reads from one left margin; the question is short and needs no
      // margin of its own. Sides are what separate them, so neither needs a
      // "You"/"Assistant" label, and the answer keeps the full column width.
      //
      // Capped rather than full width: a bubble that reaches both edges has no
      // side to be on, and a pasted paragraph would look like the agent's own.
      <div className="mt-8 mb-4 flex justify-end first:mt-0">
        <div className="max-w-[85%] rounded-lg rounded-tr-none bg-primary px-3.5 py-2.5 text-[0.9375rem] leading-relaxed font-medium text-primary-foreground">
          {attached.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attached.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={url}
                    alt="Attached"
                    className="max-h-40 max-w-full rounded border border-primary-foreground/20 object-contain"
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
                  className="flex min-w-0 items-center gap-2 rounded-md border border-primary-foreground/20 bg-primary-foreground/10 px-2.5 py-2 transition-colors hover:bg-primary-foreground/15"
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

  if (item.kind === 'assistant') return <AssistantMessage text={item.text} streaming={streaming} />
  return null
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
        className={cn('prose-agent mt-2 mb-6 max-w-none break-words', streaming && 'caret')}
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
  const spec = parseSpecFromArgs(item.args)

  if (item.ok === false || !spec) {
    // Pending (no result yet) with a valid-looking spec still shows the chart —
    // only a spec that will not parse waits. This keeps the common path instant.
    if (item.result === undefined && spec) return <SegmentView segment={{ kind: 'ui', spec }} />
    if (item.result === undefined) {
      return <div className="my-4 h-[260px] animate-pulse rounded-lg border bg-muted/30" aria-label="Preparing…" />
    }
    return (
      <p className="my-2 text-xs text-muted-foreground/70 italic">Adjusting the component…</p>
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
