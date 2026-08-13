import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRightIcon, LightbulbIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible'
import { Spinner } from '@/shared/ui/spinner'
import { describeTool, thoughtLabel } from '@/features/agents/lib/tool-summary'
import { renderMarkdown } from '@/features/agents/lib/markdown'
import { cn } from '@/shared/lib/utils'
import type { ReactNode } from 'react'
import type { Item } from '@/shared/lib/types'

/**
 * The transcript reads as a narrative: what the user asked, what the agent
 * said, and between them a quiet log of what it did to get there.
 *
 * Everything the agent *does* — reasoning, tool calls — is one collapsed line
 * with an icon, phrased as an action rather than as a runtime event. The
 * payloads are all still here, one click away; they are just no longer the
 * loudest thing on screen. The answer is what the run was for.
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
  // A model that goes straight to a tool call opens an empty text block first.
  // It has nothing to say, so it gets no line.
  const visible = items.filter((i) => i.kind !== 'assistant' || i.text.trim() !== '')

  // Scrolling is owned by the scroll container itself (see `useStickToBottom`),
  // not by this component. Following from in here would mean scrolling an
  // ancestor it does not own, and would override the reader unconditionally.
  return (
    // Top-aligned: the agent header anchors the top of this column, so the
    // transcript starts right under it rather than floating above the composer.
    <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-4 sm:px-6">
      {visible.map((item, i) => (
        <TranscriptRow key={i} item={item} streaming={running && i === visible.length - 1} />
      ))}

      {running ? (
        <ActivityLine icon={<span className="rail-head size-2 rounded-full bg-foreground/50" />}>
          <span className="shimmer flex min-h-5 items-center text-[0.8125rem]">
            {runSummary ?? 'working…'}
          </span>
        </ActivityLine>
      ) : null}
    </div>
  )
}

function TranscriptRow({ item, streaming }: { item: Item; streaming: boolean }) {
  if (item.kind === 'user') {
    // A stored turn has no `images` — it comes back as the note the server
    // appended, so the URLs are recovered from the text. A live turn has both,
    // and the ids match, so this stays one code path rather than two.
    const attached = item.images?.length ? item.images : attachedImageUrls(item.text)
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
          <p className="whitespace-pre-wrap break-words">{withoutAttachmentNote(item.text)}</p>
        </div>
      </div>
    )
  }

  // A step boundary draws nothing. It was a hairline and a "Step 3" label, and
  // it turned the transcript into a runtime log: the reader was being shown the
  // agent's loop counter, which is a number they can do nothing with and which
  // interrupted the narrative every few lines to say so.
  //
  // The item is still produced and still stored — `run-stats` counts these to
  // report how many steps a run took, which is the one place the number belongs.
  if (item.kind === 'iteration') return null

  if (item.kind === 'thinking') return <ThinkingLine item={item} streaming={streaming} />
  if (item.kind === 'tool') return <ToolLine item={item} />

  return (
    <div
      className={cn('prose-agent mt-2 mb-6 max-w-none break-words', streaming && 'caret')}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
    />
  )
}

/** One line of agent activity: an icon in the gutter, the sentence beside it. */
function ActivityLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-[0.1875rem]">
      <span
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/70"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function ThinkingLine({
  item,
  streaming,
}: {
  item: Extract<Item, { kind: 'thinking' }>
  streaming: boolean
}) {
  // Open while the thought is still arriving, closed once it has landed —
  // unless the reader has taken a side, which then wins for good.
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? streaming
  const scroller = useRef<HTMLPreElement>(null)

  // Follow the tail of a thought as it streams, inside this box only.
  useLayoutEffect(() => {
    if (!streaming || !open || !scroller.current) return
    scroller.current.scrollTop = scroller.current.scrollHeight
  }, [item.text, streaming, open])

  return (
    <ActivityLine icon={<LightbulbIcon className="size-3.5" />}>
      <Collapsible open={open} onOpenChange={setManual}>
        <TriggerRow
          label={streaming ? 'Thinking…' : thoughtLabel(item.ms)}
          muted={!streaming}
          live={streaming}
        />
        <CollapsibleContent>
          <pre
            ref={scroller}
            className="mt-1.5 max-h-56 overflow-auto rounded-lg border bg-muted/30 px-3 py-2 text-[0.8125rem] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground"
          >
            {item.text}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </ActivityLine>
  )
}

function ToolLine({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const pending = item.result === undefined
  const { Icon, done, running } = describeTool(item.name, item.args)

  return (
    <ActivityLine icon={pending ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}>
      {/*
        Collapsed by default. A tool call's arguments and result are often
        hundreds of lines of JSON, and a transcript that shows every one of them
        in full buries the answer the run was actually for. The line keeps what
        you need to skim — what it did, how long, did it fail — and the payload
        is one click away.
      */}
      <Collapsible>
        <TriggerRow
          label={done}
          prefix="Used tool:"
          meta={
            pending ? null : (
              <>
                {item.ok === false ? <span className="text-destructive">failed</span> : null}
                {/* Cost of the call, so a slow tool is visible without opening it. */}
                {item.ms !== undefined ? (
                  <span className="readout text-[0.625rem] text-muted-foreground/70">
                    {item.ms >= 1000 ? `${(item.ms / 1000).toFixed(1)}s` : `${item.ms}ms`}
                  </span>
                ) : null}
              </>
            )
          }
        />

        {/* While it runs, the same action in the present tense — the one place
            the transcript says what is happening rather than what happened. */}
        {pending ? (
          <p className="shimmer truncate pt-0.5 text-[0.8125rem]">
            {/* A phrase whose argument was already cut ends in an ellipsis of
                its own; a second one reads as a typo. */}
            {running.endsWith('…') ? running : `${running}…`}
          </p>
        ) : null}

        <CollapsibleContent>
          <div className="mt-1.5 overflow-hidden rounded-lg border bg-muted/30">
            <div className="readout border-b px-3 py-1.5 text-muted-foreground/70">{item.name}</div>

            {item.args !== '{}' ? (
              <pre className="readout overflow-x-auto px-3 py-2 leading-relaxed text-muted-foreground">
                {item.args}
              </pre>
            ) : null}

            {!pending ? (
              <div className="readout flex gap-2 border-t px-3 py-2 leading-relaxed">
                <span className="shrink-0 text-muted-foreground">→</span>
                {/* Capped and scrollable: a single MCP result can run to tens of
                    thousands of characters, and an expanded line should not push
                    the rest of the transcript off screen. */}
                <span className="max-h-72 min-w-0 overflow-auto break-words whitespace-pre-wrap">
                  {item.result}
                </span>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </ActivityLine>
  )
}

/** The clickable sentence: `Used tool: Searched "moai statues"` and a chevron. */
function TriggerRow({
  label,
  prefix,
  meta,
  muted = false,
  live = false,
}: {
  label: string
  prefix?: string
  meta?: ReactNode
  muted?: boolean
  /** The label is about to be replaced — sweep a highlight across it. */
  live?: boolean
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        'group flex w-full items-center gap-1.5 rounded text-left text-[0.8125rem] leading-5',
        'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
      )}
    >
      {prefix ? <span className="shrink-0 text-muted-foreground/70">{prefix}</span> : null}
      <span
        className={cn(
          'truncate transition-colors group-hover:text-foreground',
          muted ? 'text-muted-foreground' : 'font-medium text-foreground',
          live && 'shimmer',
        )}
      >
        {label}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-data-[state=open]:rotate-90" />
      {/* Beside the sentence rather than flushed right: on a wide column a
          duration at the far edge reads as belonging to nothing. */}
      {meta ? <span className="flex shrink-0 items-center gap-1.5">{meta}</span> : null}
    </CollapsibleTrigger>
  )
}

/**
 * The note the server appends to a user message carrying attachments.
 *
 * It is written into the message text on purpose — that is how the model sees
 * it and how a reloaded conversation still knows an image was there. It is
 * addressed to the model, though, so the console hides it and draws the
 * pictures instead.
 */
const ATTACHMENT_NOTE = /\n*\[The user attached (?:an image|\d+ images) to this message:[^\]]*\]\s*$/

const IMAGE_URL = /\/api\/images\/[A-Za-z0-9_-]+/g

function attachedImageUrls(text: string): string[] {
  const note = text.match(ATTACHMENT_NOTE)?.[0]
  return note ? [...new Set(note.match(IMAGE_URL) ?? [])] : []
}

function withoutAttachmentNote(text: string): string {
  return text.replace(ATTACHMENT_NOTE, '').trimEnd()
}
