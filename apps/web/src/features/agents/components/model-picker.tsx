import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { ModelLogo } from '@/shared/components/model-logo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { cn } from '@/shared/lib/utils'
import type { Model } from '@/shared/lib/types'

/**
 * Which model the next run uses, chosen where the question is asked.
 *
 * It is also in Settings, and that is not a duplicate to remove: the modal
 * describes itself as applying "to the next agent you start", which is the
 * composer's job, two clicks away from it. This is the same state under a
 * second, closer control — changing one moves the other.
 *
 * Deliberately quiet: no border, muted until hovered. It sits on the same row
 * as the paste-an-image hint, and a second bordered control under a bordered
 * composer would read as part of the input rather than as a setting on it.
 */
export function ModelPicker({
  models,
  modelId,
  onChange,
  lockedId = null,
}: {
  models: Model[]
  modelId: string
  onChange: (id: string) => void
  /**
   * The open chat's own model, when one is open. A chat runs on the model it
   * started with, so while you are inside one this reports that rather than
   * offering a choice — the transcript header names it two inches above, and
   * two different model names on one screen meaning two different things is
   * the confusion this avoids.
   */
  lockedId?: string | null
}) {
  // Before /api/meta answers there is nothing to name and nothing to pick, and
  // a trigger reading "Loading…" would be a button that does nothing.
  if (!models.length) return null

  if (lockedId) {
    const locked = models.find((m) => m.id === lockedId)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-default items-center gap-1.5 py-0.5 pr-1 pl-0.5 text-[0.6875rem]">
            <ModelLogo model={locked} size={14} className="rounded-[3px]" />
            <span className="readout">{locked?.label ?? lockedId}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>Start a new chat to use a different model</TooltipContent>
      </Tooltip>
    )
  }

  const current = models.find((m) => m.id === modelId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex items-center gap-1.5 rounded-md py-0.5 pr-1 pl-0.5 text-[0.6875rem]',
          'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        )}
      >
        <ModelLogo model={current} size={14} className="rounded-[3px]" />
        <span className="readout">{current?.label ?? 'Pick a model'}</span>
        <ChevronDownIcon className="size-3" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-72">
        {models.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onChange(m.id)}
            className={cn('items-start gap-2', m.id === modelId && 'bg-accent/60')}
          >
            <ModelLogo model={m} size={18} className="mt-px rounded-[4px]" />
            <span className="min-w-0 flex-1">
              <span className="readout block truncate">{m.label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {/* A model with no key cannot answer, and saying so here beats
                    letting it be chosen and fail on send. */}
                {m.ready ? m.hint : 'Needs an API key'}
              </span>
            </span>
            {m.id === modelId ? <CheckIcon className="mt-1 size-3.5 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
