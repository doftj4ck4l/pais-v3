import { renderMarkdown } from '@/features/agents/lib/markdown'
import { cn } from '@/shared/lib/utils'
import type { CardProps } from '@/features/agents/lib/ui-blocks'

/**
 * A titled panel with an optional markdown body and a list of label/value
 * fields. The body goes through the same sanitised `renderMarkdown` the rest of
 * the chat uses, so a card is no more of an XSS surface than an ordinary reply.
 */
const ACCENT: Record<NonNullable<CardProps['accent']>, string> = {
  default: 'border-l-border',
  primary: 'border-l-primary',
  success: 'border-l-emerald-500',
  warning: 'border-l-amber-500',
  destructive: 'border-l-destructive',
}

export function Card({ title, body, fields, accent = 'default' }: CardProps) {
  return (
    <div
      className={cn(
        'my-4 rounded-lg border border-l-2 bg-card p-4 text-card-foreground',
        ACCENT[accent] ?? ACCENT.default,
      )}
    >
      {title ? <h3 className="text-sm font-semibold text-foreground">{title}</h3> : null}
      {body ? (
        <div
          className={cn('prose-agent max-w-none text-sm', title && 'mt-1.5')}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      ) : null}
      {fields?.length ? (
        <dl className={cn('grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm', (title || body) && 'mt-3')}>
          {fields.map((f, i) => (
            <div key={i} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="font-medium text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
