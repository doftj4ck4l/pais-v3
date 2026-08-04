import type {
  ConversationDetail,
  ConversationRow,
  DbConnectionRow,
  DocumentRow,
  IngestResult,
  Meta,
  WorkspaceFile,
  WorkspaceRow,
} from '@/lib/types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

/**
 * Who is asking, and which body of work they are asking about.
 *
 * Passed as one object rather than two positional strings: both are opaque ids,
 * so getting them the wrong way round would type-check cleanly and silently
 * read an empty workspace. `workspaceId` may be null before the first list has
 * arrived, in which case the server picks the user's default.
 */
export type Scope = { userId: string; workspaceId: string | null }

const scoped = (scope: Scope, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ userId: scope.userId, ...extra })
  if (scope.workspaceId) params.set('workspaceId', scope.workspaceId)
  return params.toString()
}

/** Every workspace this user owns, oldest first. The server creates one if none exist. */
export async function listWorkspaces(userId: string): Promise<WorkspaceRow[]> {
  const { workspaces } = await json<{ workspaces: WorkspaceRow[] }>(
    await fetch(`/api/workspaces?userId=${encodeURIComponent(userId)}`),
  )
  return workspaces
}

export async function createWorkspace(userId: string, name: string): Promise<WorkspaceRow> {
  const { workspace } = await json<{ workspace: WorkspaceRow }>(
    await fetch(`/api/workspaces?userId=${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return workspace
}

export async function renameWorkspace(userId: string, id: string, name: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`, {
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
export async function deleteWorkspace(userId: string, id: string): Promise<{ error?: string }> {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
  if (res.ok) return {}
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return { error: body.error ?? `HTTP ${res.status}` }
}

export async function fetchMeta(): Promise<Meta> {
  return json<Meta>(await fetch('/api/meta'))
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

/** Files the agent has produced in this workspace's sandbox directory. */
export async function listWorkspaceFiles(scope: Scope): Promise<WorkspaceFile[]> {
  const { files } = await json<{ files: WorkspaceFile[] }>(
    await fetch(`/api/workspace/files?${scoped(scope)}`),
  )
  return files
}

/** Download URL for one workspace file. Served as an attachment by the API. */
export function workspaceFileUrl(scope: Scope, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  return `/api/workspace/files/${encoded}?${scoped(scope)}`
}

/** Read-only Postgres connections this browser has added. */
export async function listConnections(scope: Scope): Promise<DbConnectionRow[]> {
  const { connections } = await json<{ connections: DbConnectionRow[] }>(
    await fetch(`/api/databases?${scoped(scope)}`),
  )
  return connections
}

/**
 * Connect a read-only database. An unreachable database is not a form error —
 * the API still returns 201 with a connection whose status is 'error', which
 * the panel lists like any other. `error` here is only for a rejected request:
 * a bad name, a missing url, a duplicate name, or a missing server config.
 */
export async function addConnection(
  scope: Scope,
  name: string,
  url: string,
): Promise<{ connection?: DbConnectionRow; error?: string }> {
  const res = await fetch(`/api/databases?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, url }),
  })
  return await res.json()
}

/** One step of an attach, as the server reports it. Mirrors IntrospectPhase. */
export type AttachPhase =
  | { phase: 'connected'; name: string }
  | { phase: 'catalog'; step: string; count: number }
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
  name: string,
  url: string,
  onPhase: (p: AttachPhase) => void,
): Promise<{ connection?: DbConnectionRow; error?: string }> {
  const res = await fetch(`/api/databases/stream?${scoped(scope)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, url }),
  })

  if (!res.ok) return (await res.json()) as { error?: string }
  if (!res.body) return { error: 'The server sent no stream' }

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

  return connection ? { connection } : { error: 'The attach ended without a result' }
}

export async function refreshConnection(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/databases/${encodeURIComponent(id)}/refresh?${scoped(scope)}`, {
    method: 'POST',
  })
}

export async function deleteConnection(scope: Scope, id: string): Promise<void> {
  await fetch(`/api/databases/${encodeURIComponent(id)}?${scoped(scope)}`, { method: 'DELETE' })
}
