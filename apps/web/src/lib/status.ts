import type { AgentStatus } from '@/hooks/use-agent-board'

/** One vocabulary for run status, used by the sidebar and the agent header. */
export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'Working…',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error',
}

/** Error is the only status that earns full contrast; the rest stay quiet. */
export function statusEmphasis(status: AgentStatus): string {
  return status === 'error' ? 'font-medium text-foreground' : ''
}
