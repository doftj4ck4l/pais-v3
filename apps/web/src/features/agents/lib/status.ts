import type { AgentStatus } from '@/features/agents/hooks/use-agent-board'
import type { TranslationKey } from '@/shared/lib/i18n'

/** One translatable vocabulary for run status, used throughout the console. */
export const STATUS_KEY: Record<AgentStatus, TranslationKey> = {
  running: 'statusRunning',
  done: 'statusDone',
  stopped: 'statusStopped',
  error: 'statusError',
}

/** Error is the only status that earns full contrast; the rest stay quiet. */
export function statusEmphasis(status: AgentStatus): string {
  return status === 'error' ? 'font-medium text-foreground' : ''
}
