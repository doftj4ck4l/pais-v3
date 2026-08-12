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
  /** `images` are /api/images/<id> URLs the user attached to this turn. */
  | { kind: 'user'; text: string; images?: string[] }
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

/** An image the user pasted into the composer, already stored server-side. */
export type UploadedImage = {
  id: string
  /** `/api/images/<id>` — what the thumbnail loads and what read_image resolves. */
  url: string
  name: string
  contentType: string
  bytes: number
}

/**
 * One thing this workspace has learned about its own work, written by the
 * reflector after a run rather than by anyone typing.
 */
export type PlaybookBullet = {
  id: string
  kind: 'fact' | 'route' | 'pitfall'
  content: string
  helpful: number
  harmful: number
  /** helpful − harmful, computed server-side so the ordering matches the prompt's. */
  score: number
  /** Enough bad runs that the agent is no longer shown it. Still listed, greyed. */
  demoted: boolean
  /** Whether it survived selection into the last system prompt. */
  inPrompt: boolean
  createdAt: number
  updatedAt: number
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

export type RunStatus = 'running' | 'done' | 'error' | 'stopped'

/** One agent run: a single prompt turned into an answer. */
export type RunRow = {
  id: string
  conversationId: string
  harnessId: string
  modelId: string
  prompt: string | null
  startedAt: number
  endedAt: number | null
  status: RunStatus
  turns: number
  tokensIn: number
  tokensOut: number
  toolCalls: number
  toolErrors: number
  error: string | null
  /** Null while the run is still in flight. */
  durationMs: number | null
}

/** One bar on the waterfall, already positioned relative to the run's start. */
export type RunSpan = {
  id: string
  step: string
  startedAt: number
  endedAt: number
  durationMs: number
  offsetMs: number
  fields: Record<string, unknown>
}

export type RunDetail = {
  run: RunRow & { endedAt: number; durationMs: number }
  spans: RunSpan[]
}

/** What one MCP server advertised the last time it was probed. */
export type McpCapability = {
  kind: 'tool' | 'resource' | 'prompt'
  name: string
  description: string | null
  uri: string | null
}

/**
 * One connected MCP server. Credentials never appear here — the API omits the
 * encrypted header and env columns from every response.
 */
export type McpServerRow = {
  id: string
  name: string
  transport: 'http' | 'stdio'
  url: string | null
  command: string | null
  args: string[]
  enabled: number
  status: 'connected' | 'error'
  error: string | null
  /**
   * What the server said on the way down — a stdio launcher's stderr, or an
   * HTTP body. `error` is the one-line summary shown in the row; this is the
   * traceback behind the connection report.
   */
  errorDetail?: string | null
  toolCount: number
  lastProbedAt: number | null
  createdAt: number
  capabilities: McpCapability[]
  /**
   * Names of the configured credentials, never their values. The edit form
   * shows these so changing a URL does not mean retyping a password blind.
   */
  headerKeys?: string[]
  envKeys?: string[]
}

/** A container for one body of work: its agents, documents, databases, files. */
export type WorkspaceRow = {
  id: string
  userId: string
  name: string
  createdAt: number
}

/**
 * Who the authenticating proxy says you are. Supplied per request by the
 * identity provider, never stored by this app.
 */
export type UserProfile = {
  id: string
  username?: string
  email?: string
  name?: string
  groups: string[]
  /**
   * The name set in this console, on its own. `name` already has it applied;
   * this says whether it came from here or from the identity provider, which
   * is what lets settings offer to clear it.
   */
  displayName?: string | null
  /** The name your sign-in provides, before any override. */
  providerName?: string | null
}
