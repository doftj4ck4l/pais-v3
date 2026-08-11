import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'

/**
 * Starts a new agent. It is never bound to a running agent — stopping one
 * happens on that agent's own header.
 */
export function Composer({
  notice,
  onDismissNotice,
  onSend,
}: {
  notice: string | null
  onDismissNotice: () => void
  onSend: (text: string) => void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the prompt, up to a ceiling.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const submit = () => {
    if (!value.trim()) return
    onSend(value)
    setValue('')
  }

  return (
    <div className="border-t bg-background">
      {notice ? (
        <div className="mx-auto flex w-full max-w-5xl items-start gap-3 px-4 pt-3 sm:px-6">
          <p className="flex-1 border-l-2 border-foreground py-1 pl-3 text-xs text-muted-foreground">
            {notice}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismissNotice}
            className="-mr-1 text-muted-foreground"
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <form
        className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border bg-card p-2 pl-3 transition-colors focus-within:border-ring">
          <span
            aria-hidden
            className="readout shrink-0 pb-2.5 leading-none text-muted-foreground select-none"
          >
            →
          </span>

          <Textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Ask anything…"
            aria-label="Start a new agent"
            className="max-h-[200px] min-h-0 resize-none border-0 bg-transparent px-0 py-2 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />

          <Button type="submit" disabled={!value.trim()}>
            Send
            <ArrowUpIcon data-icon="inline-end" />
          </Button>
        </div>
      </form>
    </div>
  )
}
