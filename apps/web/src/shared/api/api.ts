import type {
  ConversationDetail,
  ConversationRow,
  DbConnectionRow,
  DocumentRow,
  IngestResult,
  McpServerRow,
  Meta,
  PlaybookBullet,
  RunDetail,
  RunSessionDetail,
  SessionImage,
  TranscriptionRow,
  TranscriptionStatus,
  UploadedImage,
  UploadedDataFile,
  RunRow,
  WorkspaceFile,
  WorkspaceRow,
  UserProfile,
  Organization,
  OrganizationSummary,
  OrganizationDetail,
  OrganizationInvitation,
  InvitationInspection,
  InvitationAcceptance,
  AdminAnalytics,
  AdminUser,
  RunStatus,
  AgentDefinition,
  AgentReply,
  AuthConfig,
} from '@/shared/lib/types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // The server's own `error` is the useful part — "add this redirect URI to
    // the OAuth client" names the fix, where a bare "HTTP 400" sends you
    // looking in the wrong place.
    const detail = await res
      .json()
      .then((body: { error?: string }) => body?.error)
      .catch(() => undefined)
    throw new Error(detail || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/**
 * Which body of work is being asked about.
 *
 * This used to carry a `userId` too, invented client-side and trusted by the
 * server. Identity now comes from the authenticating proxy, so the only thing
 * left to say is which workspace. `workspaceId` may be null before the first
 * list has arrived, in which case the server picks the user's default.
 */
export type Scope = { workspaceId: string | null }

const scoped = (scope: Scope, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ ...extra })
  if (scope.workspaceId) params.set('workspaceId', scope.workspaceId)
  return params.toString()
}

/** Every workspace this user owns, oldest first. The server creates one if none exist. */
export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  const { workspaces } = await json<{ workspaces: WorkspaceRow[] }>(await fetch('/api/workspaces'))
  return workspaces
}

export async function createWorkspace(name: string): Promise<WorkspaceRow> {
  const { workspace } = await json<{ workspace: WorkspaceRow }>(
    await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return workspace
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/**
 * Remove a workspace and everything in it. The API refuses to remove the last
 * one with a 409, which is reported rather than thrown — it is a rule, not a
 * failure.
 */
export async function deleteWorkspace(id: string): Promise<{ error?: string }> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (res.ok) return {}
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return { error: body.error ?? `HTTP ${res.status}` }
}

/** Who the active authentication mode says you are. */
export async function fetchMe(): Promise<UserProfile> {
  return json<UserProfile>(await fetch('/api/me'))
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return json<AuthConfig>(await fetch('/api/auth/config'))
}

export async function loginWithPassword(email: string, password: string): Promise<UserProfile> {
  const result = await json<{ user: UserProfile }>(
    await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  )
  return result.user
}

export async function logoutLocalSession(): Promise<void> {
  await json<{ ok: true }>(
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
}

/** Change what this console calls you. Empty clears it back to the proxy's name. */
export async function updateMe(displayName: string): Promise<UserProfile> {
  return json<UserProfile>(
    await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    }),
  )
}

export async function listOrganizations(): Promise<OrganizationSummary[]> {
  const result = await json<{ organizations: OrganizationSummary[] }>(
    await fetch('/api/admin/organizations'),
  )
  return result.organizations
}

export async function createOrganization(name: string): Promise<OrganizationSummary> {
  const result = await json<{ organization: Organization }>(
    await fetch('/api/admin/organizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return { ...result.organization, memberCount: 0, pendingInvitationCount: 0 }
}

export async function renameOrganization(id: string, name: string): Promise<Organization> {
  const result = await json<{ organization: Organization }>(
    await fetch(`/api/admin/organizations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return result.organization
}

export async function getOrganization(id: string): Promise<OrganizationDetail> {
  return json<OrganizationDetail>(
    await fetch(`/api/admin/organizations/${encodeURIComponent(id)}`),
  )
}

export async function createOrganizationInvitation(
  organizationId: string,
  email: string,
): Promise<{ invitation: OrganizationInvitation; url: string }> {
  return json<{ invitation: OrganizationInvitation; url: string }>(
    await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  )
}

export async function revokeOrganizationInvitation(
  organizationId: string,
  invitationId: string,
): Promise<void> {
  await json<{ ok: true }>(
    await fetch(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ),
  )
}

export async function removeOrganizationMember(
  organizationId: string,
  membershipId: string,
): Promise<void> {
  await json<{ ok: true }>(
    await fetch(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`,
      { method: 'DELETE' },
    ),
  )
}

export async function inspectInvitation(token: string): Promise<InvitationInspection> {
  return json<InvitationInspection>(
    await fetch('/api/invitations/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  )
}

export async function acceptInvitation(token: string): Promise<InvitationAcceptance> {
  return json<InvitationAcceptance>(
    await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  )
}

export async function fetchMeta(): Promise<Meta> {
  return json<Meta>(await fetch('/api/meta'))
}

export type AgentDefinitionInput = {
  name: string
  systemPrompt: string
  modelId: string
}

export async function listAgentDefinitions(scope: Scope): Promise<AgentDefinition[]> {
  const result = await json<{ agents: AgentDefinition[] }>(
    await fetch(`/api/agents?${scoped(scope)}`),
  )
  return result.agents
}

export async function createAgentDefinition(
  scope: Scope,
  input: AgentDefinitionInput,
): Promise<{ agent: AgentDefinition; token: string }> {
  return json<{ agent: AgentDefinition; token: string }>(
    await fetch(`/api/agents?${scoped(scope)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function updateAgentDefinition(
  scope: Scope,
  id: string,
  input: AgentDefinitionInput,
): Promise<AgentDefinition> {
  const result = await json<{ agent: AgentDefinition }>(
    await fetch(`/api/agents/${encodeURIComponent(id)}?${scoped(scope)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return result.agent
}

export async function rotateAgentToken(
  scope: Scope,
  id: string,
): Promise<{ agent: AgentDefinition; token: string }> {
  return json<{ agent: AgentDefinition; token: string }>(
    await fetch(`/api/agents/${encodeURIComponent(id)}/token?${scoped(scope)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
}

export async function previewAgent(
  scope: Scope,
  id: string,
  message: string,
): Promise<AgentReply> {
  return json<AgentReply>(
    await fetch(`/api/agents/${encodeURIComponent(id)}/preview?${scoped(scope)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    }),
  )
}

export async function deleteAgentDefinition(scope: Scope, id: string): Promise<void> {
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}?${scoped(scope)}`, {
    method: 'DELETE',
  })
  if (!response.ok) await json(response)
}

/** Stored runs for this browser, oldest first so new agents append at the end. */
export async function listConversations(scope: Scope): Promise<ConversationRow[]> {
  const { conversations } = await json<{ conversations: ConversationRow[] }>(
    await fetch(`/api/conversations?${scoped(scope)}`),
  )
  return [...conversations].reverse()
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  return json<ConversationDetail>(await fetch(`/api/conversations/${encodeURIComponent(id)}`))
}

/**
 * Stop a run in flight.
 *
 * Aborting the streaming fetch only stops this browser reading; the server run
 * keeps going. This tells the server to abort it. Best-effort: a run that has
 * already finished returns `stopped: false`, which is not an error here.
 */
export async function stopRun(scope: Scope, conversationId: string): Promise<void> {
  await fetch(`/api/chat/${encodeURIComponent(conversationId)}/stop?${scoped(scope)}`, {
    method: 'POST',
  }).catch(() => {
    // The optimistic UI has already flipped to stopped; a failed stop request
    // must not throw into the click handler.
  })
}

/**
 * Deliver the user's answer to an `ask_user` question the run is paused on.
 * The server resolves the waiting tool call and the run continues.
 */
export async function answerQuestion(
  scope: Scope,
  conversationId: string,
  questionId: string,
  answer: string,
): Promise<boolean> {
  const result = await json<{ delivered: boolean }>(
    await fetch(`/api/chat/${encodeURIComponent(conversationId)}/answer?${scoped(scope)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, answer }),
    }),
  )
  return result.delivered
}

/** Best-effort delete — a stored run that outlives the UI is not worth a crash. */
export async function deleteConversation(id: string): Promise<void> {
  try {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch {
    // offline or already gone
  }
}

/** Documents this browser has uploaded, newest first. */
export async function listDocuments(scope: Scope): Promise<DocumentRow[]> {
  const { documents } = await json<{ documents: DocumentRow[] }>(
    await fetch(`/api/documents?${scoped(scope)}`),
  )
  return documents
}

/**
 * Upload files for indexing. Resolves with one result per file: a PDF that
 * cannot be indexed is reported, not thrown, so the rest of the batch survives.
 */
export async function uploadDocuments(scope: Scope, files: File[]): Promise<IngestResult[]> {
  const body = new FormData()
  for (const file of files) body.append('files', file)
  const { results } = await json<{ results: IngestResult[] }>(
    await fetch(`/api/documents?${scoped(scope)}`, { method: 'POST', body }),
  )
  return results
}

export async function deleteDocument(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/documents/${encodeURIComponent(id)}?${scoped(scope)}`, { method: 'DELETE' })
}

/**
 * Put one audio file on the transcription queue. The server answers the moment
 * the job is recorded; poll `listTranscriptions` for its progress. An oversized
 * file (413) or a full queue (429) is reported with the server's own message.
 */
export async function enqueueTranscription(
  scope: Scope,
  file: File,
): Promise<{ transcriptionId: string; status: TranscriptionStatus }> {
  const body = new FormData()
  body.append('file', file)
  return json<{ transcriptionId: string; status: TranscriptionStatus }>(
    await fetch(`/api/documents/transcribe?${scoped(scope)}`, { method: 'POST', body }),
  )
}

/** Audio uploads this workspace has queued or transcribed, newest first. */
export async function listTranscriptions(scope: Scope): Promise<TranscriptionRow[]> {
  const { transcriptions } = await json<{ transcriptions: TranscriptionRow[] }>(
    await fetch(`/api/documents/transcriptions?${scoped(scope)}`),
  )
  return transcriptions
}

/** Remove a job and the transcript it produced. */
export async function deleteTranscription(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/documents/transcriptions/${encodeURIComponent(id)}?${scoped(scope)}`, {
    method: 'DELETE',
  })
}

/**
 * Attach an image the user pasted into the composer.
 *
 * Uploaded before the message is sent, not with it: the composer shows a
 * thumbnail immediately, and the chat request carries an id rather than a
 * megabyte of base64.
 */
export async function uploadChatImage(
  scope: Scope,
  file: File,
  conversationId?: string | null,
): Promise<UploadedImage> {
  const form = new FormData()
  form.append('file', file)
  // Null for the first message of a run, which has no conversation yet. The
  // image is still in the transcript; it just misses the session panel until
  // the next paste, which is a smaller loss than blocking the send on a row.
  if (conversationId) form.append('conversationId', conversationId)
  return json<UploadedImage>(
    await fetch(`/api/images?${scoped(scope)}`, { method: 'POST', body: form }),
  )
}

export async function uploadChatDataFile(scope: Scope, file: File): Promise<UploadedDataFile> {
  const form = new FormData()
  form.append('file', file)
  const { file: uploaded } = await json<{ file: Omit<UploadedDataFile, 'url'> }>(
    await fetch(`/api/workspace/files?${scoped(scope)}`, { method: 'POST', body: form }),
  )
  return { ...uploaded, url: workspaceFileUrl(scope, uploaded.path) }
}

/**
 * Images belonging to one chat session — generated, pasted, or shared.
 *
 * Scoped to a conversation rather than the workspace: the panel sits beside a
 * transcript, and a picture drawn in some other run is not part of this one.
 */
export async function listImages(scope: Scope, conversationId: string): Promise<SessionImage[]> {
  const { images } = await json<{ images: SessionImage[] }>(
    await fetch(`/api/images?${scoped(scope, { conversationId })}`),
  )
  return images
}

/** What this workspace has learned. Read and delete only — nothing writes from here. */
export async function listPlaybook(scope: Scope): Promise<PlaybookBullet[]> {
  const { bullets } = await json<{ bullets: PlaybookBullet[] }>(
    await fetch(`/api/playbook?${scoped(scope)}`),
  )
  return bullets
}

export async function deletePlaybookBullet(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/playbook/${encodeURIComponent(id)}?${scoped(scope)}`, { method: 'DELETE' })
}

/** Files the agent has produced in this workspace's sandbox directory. */
export async function listWorkspaceFiles(scope: Scope): Promise<WorkspaceFile[]> {
  const { files } = await json<{ files: WorkspaceFile[] }>(
    await fetch(`/api/workspace/files?${scoped(scope)}`),
  )
  return files
}

/** Download URL for one workspace file. Served as an attachment by the API. */
export function workspaceFileUrl(scope: Scope, filePath: string): string {
  const encoded = filePath.split('/').map(encodePathSegment).join('/')
  return `/api/workspace/files/${encoded}?${scoped(scope)}`
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Read-only database connections this browser has added. */
export async function listConnections(scope: Scope): Promise<DbConnectionRow[]> {
  const { connections } = await json<{ connections: DbConnectionRow[] }>(
    await fetch(`/api/databases?${scoped(scope)}`),
  )
  return connections
}

export type DatabaseApiError = {
  code: string
  message: string
  field?: string
  retryable?: boolean
}

export type DatabaseConnectionInput = {
  name: string
  engine: 'postgresql' | 'mysql' | 'sqlserver'
  host: string
  port: number
  database: string
  username: string
  password?: string
  ssl: {
    mode: 'disable' | 'require' | 'verify-full'
    ca?: string | null
    serverName?: string | null
  }
}

type DatabaseResult<T> = { ok: true; value: T } | { ok: false; error: DatabaseApiError }

export type DatabaseTestResult = {
  latencyMs: number
  serverVersion?: string
  serverProduct?: 'PostgreSQL' | 'MySQL' | 'MariaDB' | 'SQL Server'
}

async function databaseError(res: Response): Promise<DatabaseApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: DatabaseApiError | string }
  if (typeof body.error === 'string') return { code: 'request_failed', message: body.error }
  return body.error ?? { code: 'request_failed', message: `HTTP ${res.status}` }
}

/**
 * Connect a read-only database. An unreachable database is not a form error —
 * the API still returns 201 with a connection whose status is 'error', which
 * the panel lists like any other. `error` here is only for a rejected request:
 * a bad name, missing settings, a duplicate name, or missing server config.
 */
export async function addConnection(
  scope: Scope,
  input: DatabaseConnectionInput,
): Promise<{ connection?: DbConnectionRow; error?: DatabaseApiError }> {
  const res = await fetch(`/api/databases?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return { error: await databaseError(res) }
  return await res.json()
}

/** One step of an attach, as the server reports it. Mirrors IntrospectPhase. */
export type AttachPhase =
  | { phase: 'connected'; name: string }
  | { phase: 'catalog'; step: 'tables' | 'columns' | 'primaryKeys' | 'foreignKeys' | 'indexes'; count: number }
  | { phase: 'building'; tables: number; columns: number }
  | { phase: 'indexing'; entries: number }
  | { phase: 'done'; tables: number; columns: number; entries: number; ms: number }
  | { phase: 'failed'; step: string; error: string }

/**
 * Connect a database, reporting each phase as it happens.
 *
 * Uses `fetch` + a stream reader rather than `EventSource`, which cannot POST —
 * and the credential must go in a body, never a query string. A rejected request
 * still answers with ordinary JSON and its real status code, so the stream is
 * only read once the server has committed to doing work.
 */
export async function addConnectionStreaming(
  scope: Scope,
  input: DatabaseConnectionInput,
  onPhase: (p: AttachPhase) => void,
): Promise<{ connection?: DbConnectionRow; error?: DatabaseApiError }> {
  const res = await fetch(`/api/databases/stream?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!res.ok) return { error: await databaseError(res) }
  if (!res.body) return { error: { code: 'empty_stream', message: 'The server sent no stream' } }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let connection: DbConnectionRow | undefined

  // SSE frames are separated by a blank line and can split across chunks, so the
  // tail of the buffer is kept until its terminator arrives.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let split: number
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)

      const data = frame
        .split('\n')
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim()
      if (!data) continue

      try {
        const parsed = JSON.parse(data) as { type?: string; connection?: DbConnectionRow }
        if (parsed.type === 'phase') onPhase(parsed as unknown as AttachPhase)
        else if (parsed.type === 'connection') connection = parsed.connection
      } catch {
        // A malformed frame is not worth failing the whole attach over.
      }
    }
  }

  return connection
    ? { connection }
    : { error: { code: 'empty_stream', message: 'The attach ended without a result' } }
}

export async function testConnection(
  scope: Scope,
  input: DatabaseConnectionInput,
): Promise<DatabaseResult<DatabaseTestResult>> {
  const res = await fetch(`/api/databases/test?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return { ok: false, error: await databaseError(res) }
  return (await res.json()) as DatabaseResult<DatabaseTestResult>
}

export async function testStoredConnection(
  scope: Scope,
  id: string,
): Promise<DatabaseResult<DatabaseTestResult>> {
  const res = await fetch(`/api/databases/${encodeURIComponent(id)}/test?${scoped(scope)}`, {
    method: 'POST',
  })
  if (!res.ok) return { ok: false, error: await databaseError(res) }
  return (await res.json()) as DatabaseResult<DatabaseTestResult>
}

export async function updateConnection(
  scope: Scope,
  id: string,
  input: DatabaseConnectionInput,
): Promise<{ connection?: DbConnectionRow; error?: DatabaseApiError }> {
  const res = await fetch(`/api/databases/${encodeURIComponent(id)}?${scoped(scope)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return { error: await databaseError(res) }
  return (await res.json()) as { connection?: DbConnectionRow }
}

export async function refreshConnection(scope: Scope, id: string): Promise<DbConnectionRow> {
  const res = await fetch(`/api/databases/${encodeURIComponent(id)}/refresh?${scoped(scope)}`, {
    method: 'POST',
  })
  const { connection } = await json<{ connection: DbConnectionRow }>(res)
  return connection
}

export async function deleteConnection(scope: Scope, id: string): Promise<void> {
  const res = await fetch(`/api/databases/${encodeURIComponent(id)}?${scoped(scope)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function listMcpServers(scope: Scope): Promise<McpServerRow[]> {
  const { servers } = await json<{ servers: McpServerRow[] }>(
    await fetch(`/api/mcp?${scoped(scope)}`),
  )
  return servers
}

/** What the add form collects, before it becomes a request body. */
export type NewMcpServerInput = {
  name: string
  transport: 'http' | 'stdio'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Add an MCP server.
 *
 * An unreachable server is not a form error: the API returns 201 with a row
 * whose status is 'error', which the panel lists like any other. `error` here
 * is only for a rejected request — a bad name, a duplicate, a disallowed stdio
 * command, or a missing server config.
 */
export async function addMcpServer(
  scope: Scope,
  input: NewMcpServerInput,
): Promise<{ server?: McpServerRow; error?: string }> {
  const res = await fetch(`/api/mcp?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as { server?: McpServerRow; error?: string }
  if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` }
  return { server: body.server }
}

/**
 * Edit an existing server's connection.
 *
 * Omitting `headers`/`env` keeps whatever is stored — the API never sends a
 * credential back, so an edit form has nothing to re-submit and must be able to
 * say "leave it alone". Sending `{}` is the explicit way to clear one.
 *
 * Unlike `setMcpServerEnabled`, this re-probes: the cached tool catalog
 * describes the old connection and would be wrong the moment a URL changes.
 */
export async function updateMcpServer(
  scope: Scope,
  id: string,
  input: NewMcpServerInput,
): Promise<{ server?: McpServerRow; error?: string }> {
  const res = await fetch(`/api/mcp/${encodeURIComponent(id)}?${scoped(scope)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as { server?: McpServerRow; error?: string }
  if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` }
  return { server: body.server }
}

export async function refreshMcpServer(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/mcp/${encodeURIComponent(id)}/refresh?${scoped(scope)}`, { method: 'POST' })
}

export async function setMcpServerEnabled(
  scope: Scope,
  id: string,
  enabled: boolean,
): Promise<void> {
  await fetch(`/api/mcp/${encodeURIComponent(id)}?${scoped(scope)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function deleteMcpServer(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/mcp/${encodeURIComponent(id)}?${scoped(scope)}`, { method: 'DELETE' })
}

/** One server in another workspace, described well enough to decide about it. */
export type ImportableServer = {
  id: string
  name: string
  transport: 'http' | 'stdio'
  url: string | null
  command: string | null
  args: string[]
  status: 'connected' | 'error'
  toolCount: number
  /** Credential names that will be copied along with it. Never their values. */
  headerKeys: string[]
  envKeys: string[]
  /**
   * This workspace already has a *different* server by that name, so the import
   * renames the copy. An identical one would not be listed at all.
   */
  nameTaken: boolean
}

export type ImportSource = {
  workspaceId: string
  workspaceName: string
  servers: ImportableServer[]
}

export type ImportCatalog = {
  sources: ImportSource[]
  /**
   * How many were left out because this workspace is already connected to the
   * same thing. An empty list means something different when this is non-zero,
   * and the screen says so rather than implying nothing was ever set up.
   */
  alreadyHere: number
}

/** Everything configured in this user's *other* workspaces, grouped by workspace. */
export async function listImportableMcpServers(scope: Scope): Promise<ImportCatalog> {
  return await json<ImportCatalog>(await fetch(`/api/mcp/importable?${scoped(scope)}`))
}

/**
 * Copy a server here from another workspace, credentials and all.
 *
 * A copy: editing or removing it afterwards leaves the original alone. Like
 * `addMcpServer`, an unreachable result is a stored row rather than an error —
 * `error` means the request itself was refused.
 */
export async function importMcpServer(
  scope: Scope,
  sourceWorkspaceId: string,
  serverId: string,
): Promise<{ server?: McpServerRow; error?: string }> {
  const res = await fetch(`/api/mcp/import?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceWorkspaceId, serverId }),
  })
  const body = (await res.json().catch(() => ({}))) as { server?: McpServerRow; error?: string }
  if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` }
  return { server: body.server }
}

export type AdminRunFilters = {
  limit?: number
  offset?: number
  query?: string
  userId?: string
  organizationId?: string
  status?: RunStatus
}

export async function getAdminAnalytics(days = 30, signal?: AbortSignal): Promise<AdminAnalytics> {
  return json<AdminAnalytics>(await fetch(`/api/admin/analytics?days=${days}`, { signal }))
}

export async function listAdminUsers(input: { limit?: number; offset?: number; query?: string; signal?: AbortSignal } = {}): Promise<{ users: AdminUser[]; total: number }> {
  const query = new URLSearchParams()
  query.set('limit', String(input.limit ?? 50))
  query.set('offset', String(input.offset ?? 0))
  if (input.query) query.set('q', input.query)
  return json<{ users: AdminUser[]; total: number }>(await fetch(`/api/admin/users?${query}`, { signal: input.signal }))
}

/** Recent runs across every user and workspace. */
export async function listRuns(filters: AdminRunFilters = {}, signal?: AbortSignal): Promise<{ runs: RunRow[]; total: number }> {
  const query = new URLSearchParams()
  query.set('limit', String(filters.limit ?? 50))
  query.set('offset', String(filters.offset ?? 0))
  if (filters.query) query.set('q', filters.query)
  if (filters.userId) query.set('userId', filters.userId)
  if (filters.organizationId) query.set('organizationId', filters.organizationId)
  if (filters.status) query.set('status', filters.status)
  return json<{ runs: RunRow[]; total: number }>(await fetch(`/api/admin/runs?${query}`, { signal }))
}

/** One run and its spans, already positioned relative to the run's start. */
export async function getRun(id: string, signal?: AbortSignal): Promise<RunDetail> {
  return json<RunDetail>(
    await fetch(`/api/admin/runs/${encodeURIComponent(id)}`, { signal }),
  )
}

export async function getRunSession(id: string, signal?: AbortSignal): Promise<RunSessionDetail> {
  return json<RunSessionDetail>(
    await fetch(`/api/admin/runs/${encodeURIComponent(id)}/session`, { signal }),
  )
}

// ---- connectors ----

export type ConnectorKind = 'gdrive' | 'gcal'

export type ConnectorRow = {
  id: string
  kind: ConnectorKind
  accountEmail: string | null
  status: 'connected' | 'syncing' | 'error'
  error: string | null
  lastSyncAt: number | null
  documentCount: number
}

export type SyncOutcome = {
  indexed: number
  updated: number
  unchanged: number
  removed: number
  skipped: { title: string; reason: string }[]
  failed: { title: string; reason: string }[]
  ms: number
}

export async function listConnectors(
  scope: Scope,
): Promise<{ connectors: ConnectorRow[]; available: { kind: string; reason: string }[] }> {
  return json(await fetch(`/api/connectors?${scoped(scope)}`))
}

/**
 * Where to send the browser for Google's consent screen.
 *
 * The server returns a URL rather than redirecting, because this is a fetch
 * from the SPA and a cross-origin 302 would be blocked before any consent
 * screen appeared.
 */
export async function googleAuthUrl(scope: Scope, kind: ConnectorKind = 'gdrive'): Promise<string> {
  const { url } = await json<{ url: string }>(
    await fetch(`/api/connectors/google/auth?${scoped(scope)}&kind=${kind}`),
  )
  return url
}

export async function syncConnector(scope: Scope, id: string): Promise<SyncOutcome> {
  return json(
    await fetch(`/api/connectors/${encodeURIComponent(id)}/sync?${scoped(scope)}`, {
      method: 'POST',
    }),
  )
}

export async function deleteConnector(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/connectors/${encodeURIComponent(id)}?${scoped(scope)}`, { method: 'DELETE' })
}
