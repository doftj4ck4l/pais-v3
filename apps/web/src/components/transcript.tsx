import { ChevronRightIcon, WrenchIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { NodeHead, NodeRing, NodeSquare, NodeTick, RailRow } from '@/components/loop-rail'
import { Spinner } from '@/components/ui/spinner'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import type { Item } from '@/lib/types'

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
  // It has nothing to say, so it gets no node on the rail.
  const visible = items.filter((i) => i.kind !== 'assistant' || i.text.trim() !== '')

  // Scrolling is owned by the scroll container itself (see `useStickToBottom`),
  // not by this component. Following from in here would mean scrolling an
  // ancestor it does not own, and would override the reader unconditionally.
  return (
    // Top-aligned: the agent header anchors the top of this column, so the rail
    // should start right under it rather than float above the composer.
    <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-4 sm:px-6">
      {visible.map((item, i) => {
        const last = i === visible.length - 1
        return (
          <TranscriptRow
            key={i}
            item={item}
            streaming={running && last}
            // Without a live head below it, the rail should stop at the last node.
            stub={last && !running}
          />
        )
      })}

      {running ? (
        <RailRow glyph={<NodeHead />} stub>
          <p className="readout pt-0.5 text-muted-foreground">{runSummary ?? 'working…'}</p>
        </RailRow>
      ) : null}
    </div>
  )
}

function TranscriptRow({
  item,
  streaming,
  stub,
}: {
  item: Item
  streaming: boolean
  stub: boolean
}) {
  if (item.kind === 'user') {
    return (
      <RailRow glyph={<NodeSquare filled />} stub={stub}>
        <div className="inline-block max-w-full rounded-lg rounded-tl-none bg-primary px-3.5 py-2.5 text-[0.9375rem] leading-relaxed font-medium text-primary-foreground">
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
        </div>
      </RailRow>
    )
  }

  if (item.kind === 'iteration') {
    return (
      <RailRow
        glyph={<NodeTick />}
        marker={String(item.n).padStart(2, '0')}
        stub={stub}
      >
        <div className="flex items-center gap-3 pt-[0.3rem]">
          <span className="label text-muted-foreground">Step {item.n}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      </RailRow>
    )
  }

  if (item.kind === 'thinking') {
    return (
      <RailRow dashed stub={stub}>
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
<span className="label">Thinking</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="readout mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words pl-5 leading-relaxed text-muted-foreground">
              {item.text}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </RailRow>
    )
  }

  if (item.kind === 'tool') {
    const pending = item.result === undefined
    return (
      <RailRow glyph={<NodeSquare filled={!pending} />} stub={stub}>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="readout truncate font-medium text-card-foreground">{item.name}</span>
            {pending ? (
              <Spinner className="ml-auto size-3.5 text-muted-foreground" />
            ) : (
              <span className="readout ml-auto flex shrink-0 items-center gap-1.5 text-[0.625rem]">
                {item.ok === false ? (
                  <span className="text-destructive">failed</span>
                ) : null}
                {/* Cost of the call, so a slow tool is visible without opening the trace. */}
                {item.ms !== undefined ? (
                  <span className="tabular-nums text-muted-foreground">
                    {item.ms >= 1000 ? `${(item.ms / 1000).toFixed(1)}s` : `${item.ms}ms`}
                  </span>
                ) : null}
              </span>
            )}
          </div>

          {item.args !== '{}' ? (
            <pre className="readout overflow-x-auto px-3 py-2 leading-relaxed text-muted-foreground">
              {item.args}
            </pre>
          ) : null}

          {!pending ? (
            <div className="readout flex gap-2 border-t px-3 py-2 leading-relaxed">
              <span className="shrink-0 text-muted-foreground">→</span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{item.result}</span>
            </div>
          ) : null}
        </div>
      </RailRow>
    )
  }

  return (
    <RailRow glyph={<NodeRing />} stub={stub}>
      <div
        className={cn('prose-agent max-w-none break-words', streaming && 'caret')}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
      />
    </RailRow>
  )
}
