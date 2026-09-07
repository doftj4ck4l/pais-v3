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
  /** Whether this model runs the full agent or receives text chat only. */
  mode: 'agent' | 'chat-only'
  ready: boolean
  /** Usable context window in tokens, as declared by the API catalog. */
  contextWindow: number
  /**
   * Present when the model always reasons and its effort is adjustable. Drives
   * the effort control in the composer; absent on plain chat models.
   */
  thinking?: { levels: string[]; default: string }
}

export type Meta = {
  harnesses: Harness[]
  models: Model[]
}

export type ConversationMode = 'chat' | 'work'

/** A reusable prompt-only agent configured inside one workspace. */
export type AgentDefinition = {
  id: string
  workspaceId: string
  name: string
  systemPrompt: string
  modelId: string
  /** Last four characters only. The full key is revealed when minted. */
  tokenHint: string
  endpoint: string
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export type AgentReply = {
  agentId: string
  agentName: string
  modelId: string
  reply: string
}

/** One entry in the transcript. Order is the order the agent produced it. */
export type Item =
  /** Attachments are already stored; the turn carries lightweight references. */
  | { kind: 'user'; text: string; images?: string[]; files?: UploadedDataFile[] }
  | { kind: 'assistant'; text: string }
  /** `ms` is how long the reasoning streamed for — `Thought for 6 seconds`. */
  | { kind: 'thinking'; text: string; ms?: number }
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
  workspaceId: string | null
  title: string
  modelId: string
  harnessId: string
  status: ConversationStatus
  pinned: boolean
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

export type DocumentDetail = {
  document: {
    title: string
    content: string
    chunkCount: number
  }
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

export type TranscriptionStatus = 'queued' | 'transcribing' | 'indexing' | 'done' | 'failed'

/** An audio upload the workspace is (or was) transcribing. */
export type TranscriptionRow = {
  id: string
  workspaceId: string
  title: string
  bytes: number
  status: TranscriptionStatus
  model: string | null
  error: string | null
  documentId: string | null
  /** New recordings retain their source; older rows may not have one. */
  hasAudio: boolean
  createdAt: number
  updatedAt: number
}

export type TranscriptionSegment = {
  start: number
  text: string
}

export type TranscriptionDetail = {
  transcription: TranscriptionRow
  content: string | null
  segments: TranscriptionSegment[]
}

export type WorkspaceFile = {
  path: string
  bytes: number
  modifiedAt: number
  /**
   * The chat that wrote this file, where a transcript names it.
   *
   * Null is the common and honest case: a file `bash` produced is named
   * nowhere, and guessing from its timestamp would misattribute anything two
   * parallel runs touched.
   */
  origin?: { conversationId: string; title: string } | null
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

/** A CSV/XLSX/PDF/DOCX/PPTX file uploaded into the workspace for this chat turn. */
export type UploadedDataFile = {
  /** Workspace-relative path sent to POST /api/chat. */
  path: string
  /** Download URL used by the transcript's file chip. */
  url: string
  name: string
  contentType: string
  bytes: number
}

/** An indexed workspace document selected through the Chat @mention picker. */
export type MentionedDocument = {
  id: string
  title: string
}

/** Everything uploaded alongside one user turn. */
export type ChatAttachments = {
  images: UploadedImage[]
  dataFiles: UploadedDataFile[]
  documents?: MentionedDocument[]
}

/**
 * A stored image, as `/api/images` lists it.
 *
 * `source` is the only thing separating three quite different histories: an
 * image the model drew, one the user pasted, and one the agent handed over from
 * its workspace with `share_file`. The panel labels them differently for the
 * same reason the column exists — a paste is not a generation.
 */
export type SessionImage = {
  id: string
  conversationId: string | null
  prompt: string
  model: string
  contentType: string
  bytes: number
  source: 'generated' | 'uploaded' | 'shared'
  createdAt: number
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
  engine: 'postgresql' | 'mysql' | 'sqlserver' | 'sybase'
  status: 'connected' | 'error'
  error: string | null
  host: string
  port: number
  database: string
  username: string
  sslMode: 'disable' | 'require' | 'verify-full'
  hasCustomCa: boolean
  tableCount: number
  lastIntrospectedAt: number | null
  createdAt: number
  /** True when the workspace did not create this connection — a department
   * shared it. Rendered read-only (no edit/remove) once granted. */
  granted?: boolean
}

export type OrganizationGrants = {
  connectionIds: string[]
}

export type RunStatus = 'running' | 'done' | 'error' | 'stopped'

/** One agent run: a single prompt turned into an answer. */
export type RunRow = {
  id: string
  conversationId: string
  workspaceId: string | null
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
  userId: string | null
  displayName: string | null
  email: string | null
  workspaceName: string | null
  organizations: Array<{ id: string; name: string }>
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

export type RunSessionDetail = Pick<ConversationDetail, 'conversation' | 'messages'>

export type AdminActivityDay = {
  date: string
  runs: number
  conversations: number
  activeUsers: number
  tokensIn: number
  tokensOut: number
  errors: number
}

export type AdminAnalytics = {
  generatedAt: number
  periodDays: number
  totals: {
    users: number
    workspaces: number
    organizations: number
    conversations: number
    runs: number
    tokensIn: number
    tokensOut: number
    toolCalls: number
    toolErrors: number
  }
  period: {
    runs: number
    conversations: number
    activeUsers: number
    tokensIn: number
    tokensOut: number
    errors: number
    previousRuns: number
    previousTokensIn: number
    previousTokensOut: number
  }
  daily: AdminActivityDay[]
  statuses: Array<{ status: string; runs: number }>
  models: Array<{ modelId: string; runs: number; tokensIn: number; tokensOut: number }>
}

export type AdminUser = {
  userId: string
  displayName: string | null
  email: string | null
  createdAt: number
  workspaceCount: number
  conversationCount: number
  runCount: number
  tokensIn: number
  tokensOut: number
  toolCalls: number
  toolErrors: number
  lastActiveAt: number | null
  organizations: Array<{ id: string; name: string }>
}

/** What one MCP server advertised the last time it was probed. */
export type McpCapability = {
  kind: 'tool' | 'resource' | 'prompt'
  name: string
  description: string | null
  uri: string | null
  /** Nextcloud tool access, derived from the same fail-closed policy used at execution. */
  access: 'read' | 'write' | null
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
 * Who the active authentication mode says you are.
 */
export type AuthMode = 'proxy' | 'local' | 'dev'

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
  /** Derived by the API from the trusted email allowlist; presentation only. */
  canAdministerOrganizations: boolean
  /** How this deployment authenticated the current browser. */
  authMode: AuthMode
}

export type AuthConfig = {
  mode: AuthMode
  passwordLogin: boolean
}

export type Organization = {
  id: string
  name: string
  createdByUserId: string
  createdAt: number
  updatedAt: number
}

export type OrganizationSummary = Organization & {
  memberCount: number
  pendingInvitationCount: number
}

export type OrganizationMemberRole = 'admin' | 'member'

export type OrganizationMember = {
  id: string
  organizationId: string
  userId: string
  email: string
  role: OrganizationMemberRole
  joinedAt: number
}

export type OrganizationInvitationState = 'actionable' | 'expired' | 'revoked' | 'used'

export type OrganizationInvitation = {
  id: string
  organizationId: string
  email: string
  role: OrganizationMemberRole
  expiresAt: number
  acceptedAt: number | null
  revokedAt: number | null
  createdAt: number
  state: OrganizationInvitationState
}

export type OrganizationDetail = {
  organization: Organization
  members: OrganizationMember[]
  invitations: OrganizationInvitation[]
}

export type InvitationInspection =
  | {
      state: 'actionable'
      organization: { id: string; name: string }
      expiresAt: number
    }
  | { state: 'expired' | 'revoked' | 'used' | 'unavailable' }

export type InvitationAcceptance =
  | { state: 'joined'; organization: { id: string; name: string } }
  | InvitationInspection
