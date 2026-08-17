import { useState } from 'react'
import { Button } from '@/shared/ui/button'
import type { PendingQuestion } from '@/features/agents/hooks/use-agent-board'

/**
 * The agent has stopped mid-run to ask the user something, and the run is
 * blocked on the server until this is answered. Rendered above the composer,
 * not in the transcript, because it is an action the user must take now — the
 * options are buttons, and a free-text field covers "none of these".
 */
export function AskUserPrompt({
  question,
  onAnswer,
}: {
  question: PendingQuestion
  onAnswer: (text: string) => void
}) {
  const [text, setText] = useState('')
  const hasOptions = question.options.length > 0
  const isApproval = question.kind === 'approval'

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
        <p className="text-sm font-medium leading-snug">{question.question}</p>

        {hasOptions ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {question.options.map((opt) => (
              <Button key={opt} size="sm" variant="outline" onClick={() => onAnswer(opt)}>
                {opt}
              </Button>
            ))}
          </div>
        ) : null}

        {!isApproval ? (
          <form
            className="mt-2.5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const t = text.trim()
              if (t) onAnswer(t)
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={hasOptions ? 'or type your own answer…' : 'type your answer…'}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:border-foreground/40"
            />
            <Button type="submit" size="sm" disabled={!text.trim()}>
              Send
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
