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
  /** Usable context window in tokens, as declared by the API catalog. */
  contextWindow: number
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
  | {
      kind: 'tool'
      id: string
      name: string
      args: string
      result?: string
      /** Wall-clock duration, once the result arrives. */
      ms?: number
      /** False when the tool reported a failure. */
      ok?: boolean
    }

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

export type DocumentStatus = 'indexed' | 'empty' | 'error'

export type DocumentRow = {
  id: string
  userId: string
  title: string
  bytes: number
  pages: number
  chunkCount: number
  status: DocumentStatus
  error: string | null
  createdAt: number
}

/** One file's outcome from an upload — the whole batch never fails as a unit. */
export type IngestResult = {
  documentId?: string
  title: string
  status: DocumentStatus
  pages: number
  chunks: number
  error?: string
}

export type WorkspaceFile = {
  path: string
  bytes: number
  modifiedAt: number
}

export type DbConnectionRow = {
  id: string
  name: string
  engine: string
  status: 'connected' | 'error'
  error: string | null
  displayHost: string
  displayDatabase: string
  tableCount: number
  lastIntrospectedAt: number | null
  createdAt: number
}

/** A container for one body of work: its agents, documents, databases, files. */
export type WorkspaceRow = {
  id: string
  userId: string
  name: string
  createdAt: number
}
