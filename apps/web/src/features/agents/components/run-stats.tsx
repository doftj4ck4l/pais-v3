import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import type { AgentRun } from '@/features/agents/hooks/use-agent-board'

/** What the selected agent has done so far, at a glance. */
export function RunStats({ agent }: { agent: AgentRun }) {
  const steps = agent.items.reduce((n, i) => (i.kind === 'iteration' ? Math.max(n, i.n) : n), 0)
  const tools = agent.items.filter((i) => i.kind === 'tool').length
  const running = agent.status === 'running'

  return (
    <dl className="flex flex-col gap-1.5">
      <Stat term="Steps" value={steps || '—'} />
      <Stat term="Tools used" value={tools || '—'} />
      <Stat
        term="Time"
        value={agent.elapsed ? `${(agent.elapsed / 1000).toFixed(1)}s` : '—'}
        live={running}
      />
    </dl>
  )
}

function Stat({ term, value, live = false }: { term: string; value: ReactNode; live?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <span className="mb-1 h-px flex-1 bg-border" />
      <dd className={cn('readout text-sm font-medium', live && 'text-foreground')}>{value}</dd>
    </div>
  )
}
