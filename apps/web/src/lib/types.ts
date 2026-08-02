export type Harness = {
  id: string
  label: string
  description: string
  tagline: string
}

export type Model = {
  id: string
  label: string
  provider: string
  hint: string
  brand: string
  ready: boolean
}

export type Meta = {
  harnesses: Harness[]
  models: Model[]
}

/** One entry in the transcript. Order is the order the agent produced it. */
export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'iteration'; n: number }
  | { kind: 'tool'; id: string; name: string; args: string; result?: string }

export type TraceLine = { ts: number; step: string; fields: Record<string, unknown> }

/** Runtime state the pi harness reports mid-run: active tools and queue depth. */
export type Slots = { tools?: string[]; steer?: number; followUp?: number }

// ── Stored runs, as returned by /api/conversations ───────────────────────────

/** How a run ended. `running` means it is still in flight. */
export type ConversationStatus = 'running' | 'done' | 'stopped' | 'error'

export type ConversationRow = {
  id: string
  userId: string
  title: string
  modelId: string
  harnessId: string
  status: ConversationStatus
  createdAt: number
  updatedAt: number
}

export type MessageRow = {
  id: string
  conversationId: string
  kind: string
  seq: number
  text: string | null
  ts: number
}

export type TraceRow = {
  id: string
  conversationId: string
  step: string
  fields: string | null
  ts: number
}

export type ConversationDetail = {
  conversation: ConversationRow
  messages: MessageRow[]
  traces: TraceRow[]
}
