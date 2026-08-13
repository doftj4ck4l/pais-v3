import { useCallback, useEffect, useState } from 'react'
import { BrainIcon, LightbulbIcon, RouteIcon, TrafficConeIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { deletePlaybookBullet, listPlaybook } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { PlaybookBullet } from '@/shared/lib/types'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import { cn } from '@/shared/lib/utils'

/**
 * What the agent has worked out for itself, and the one control over it.
 *
 * Read and delete, deliberately: a bullet gets in by being learned, so an edit
 * box here would quietly turn a store that writes itself into a second settings
 * screen. Deleting is enough — it is the repair for a bullet that is wrong, and
 * anything the user wants to *add* they can simply tell the agent.
 *
 * Demoted bullets are shown, greyed, rather than hidden. A bullet the agent has
 * stopped trusting is the most interesting row on the page: it is either a fact
 * that went stale or a lesson learned wrongly, and both want a human to look.
 */

const KINDS = {
  fact: { label: 'Facts', icon: LightbulbIcon, blurb: 'Things it was told, and kept' },
  route: { label: 'Routes', icon: RouteIcon, blurb: 'How it gets things done here' },
  pitfall: { label: 'Dead ends', icon: TrafficConeIcon, blurb: "Things it won't try again" },
} as const

export function PlaybookPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [bullets, setBullets] = useState<PlaybookBullet[]>([])
  const scope = useScope()

  const refresh = useCallback(async () => {
    try {
      setBullets(await listPlaybook(scope))
    } catch {
      // Secondary to the console; a listing failure is not worth an error state.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => onCountChange?.(bullets.length), [bullets.length, onCountChange])

  const remove = useCallback(
    async (id: string) => {
      setBullets((prev) => prev.filter((b) => b.id !== id)) // optimistic
      await deletePlaybookBullet(scope, id)
      await refresh()
    },
    [refresh, scope],
  )

  const active = bullets.filter((b) => b.inPrompt).length

  return (
    <div className="flex flex-col">
      <PanelHeader summary={bullets.length ? `${active} of ${bullets.length} in use` : null} />

      {bullets.length === 0 ? (
        <PanelEmpty
          icon={BrainIcon}
          title="Nothing learned yet"
          description="After each run the agent writes down what it worked out — facts you told it, tools that worked, and dead ends worth avoiding."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((kind) => {
            const group = bullets.filter((b) => b.kind === kind)
            if (!group.length) return null
            const { label, icon: Icon, blurb } = KINDS[kind]
            return (
              <section key={kind}>
                <div className="mb-2 flex items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="label text-muted-foreground">{label}</span>
                  <span className="readout text-muted-foreground/70">{blurb}</span>
                </div>
                <PanelGrid>
                  {group.map((bullet) => (
                    <BulletItem
                      key={bullet.id}
                      bullet={bullet}
                      onRemove={() => void remove(bullet.id)}
                    />
                  ))}
                </PanelGrid>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BulletItem({ bullet, onRemove }: { bullet: PlaybookBullet; onRemove: () => void }) {
  // Two different reasons a bullet is not in the prompt, and they want
  // different explanations: it lost the agent's trust, or it simply lost the
  // ranking. Conflating them would make a healthy overflow look like a fault.
  const reason = bullet.demoted
    ? `Set aside — it preceded ${bullet.harmful} run${bullet.harmful === 1 ? '' : 's'} that went wrong. Still here so you can judge it.`
    : !bullet.inPrompt
      ? 'Not in the prompt right now: the playbook is over its size budget and this scored below the cut.'
      : null

  return (
    <ItemCard
      title={
        <span
          className={cn(
            'font-normal',
            !bullet.inPrompt && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
        >
          {bullet.content}
        </span>
      }
      meta={
        <span className="flex items-center gap-1.5">
          {bullet.helpful > 0 ? <span>confirmed {bullet.helpful}×</span> : null}
          {bullet.harmful > 0 ? <span>doubted {bullet.harmful}×</span> : null}
          {reason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help underline decoration-dotted">not in use</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{reason}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="Forget this"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon />
        </Button>
      }
    />
  )
}
