import { useState } from 'react'
import { ArrowUpRightIcon } from 'lucide-react'
import { useSuggestions } from '@/features/agents/hooks/use-suggestions'
import { BrandMark } from '@/shared/components/brand'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { useMe } from '@/features/workspace/hooks/use-me'
import type { TranslationKey } from '@/shared/lib/i18n'

/** One rotating line, picked fresh on every mount, like a chat product's intro. */
export function Greeting() {
  const { t } = usePreferences()
  const me = useMe()
  const [pick] = useState(() => Math.floor(Math.random() * 10))

  const rawName = me?.name?.trim() || me?.providerName || me?.email || 'there'
  const name = rawName.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 pb-6 text-center sm:px-6">
      <span className="flex size-10 items-center justify-center rounded-xl border bg-card shadow-sm">
        <BrandMark className="h-6" />
      </span>
      <h1 className="mt-5 text-2xl font-medium tracking-[-0.03em] sm:text-[1.75rem]">
        {t(`greeting${pick}` as TranslationKey, { name })}
      </h1>
    </div>
  )
}

export function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  const suggestions = useSuggestions()

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-8 sm:px-6">
      <div className="grid gap-2 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.text}
            type="button"
            onClick={() => onPick(suggestion.text)}
            className="group flex min-h-20 items-start gap-3 rounded-2xl border bg-background p-3.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block line-clamp-2 text-sm leading-snug font-medium">
                {suggestion.text}
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {suggestion.hint}
              </span>
            </span>
            <ArrowUpRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </div>
  )
}
