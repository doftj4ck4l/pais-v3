import type {
  ConversationDetail,
  ConversationRow,
  DbConnectionRow,
  DocumentRow,
  IngestResult,
  Meta,
  WorkspaceFile,
} from '@/lib/types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function fetchMeta(): Promise<Meta> {
  return json<Meta>(await fetch('/api/meta'))
}

/** Stored runs for this browser, oldest first so new agents append at the end. */
export async function listConversations(userId: string): Promise<ConversationRow[]> {
  const { conversations } = await json<{ conversations: ConversationRow[] }>(
    await fetch(`/api/conversations?userId=${encodeURIComponent(userId)}`),
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
export async function listDocuments(userId: string): Promise<DocumentRow[]> {
  const { documents } = await json<{ documents: DocumentRow[] }>(
    await fetch(`/api/documents?userId=${encodeURIComponent(userId)}`),
  )
  return documents
}

/**
 * Upload files for indexing. Resolves with one result per file: a PDF that
 * cannot be indexed is reported, not thrown, so the rest of the batch survives.
 */
export async function uploadDocuments(userId: string, files: File[]): Promise<IngestResult[]> {
  const body = new FormData()
  for (const file of files) body.append('files', file)
  const { results } = await json<{ results: IngestResult[] }>(
    await fetch(`/api/documents?userId=${encodeURIComponent(userId)}`, { method: 'POST', body }),
  )
  return results
}

export async function deleteDocument(userId: string, id: string): Promise<void> {
  await fetch(`/api/documents/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}

/** Files the agent has produced in this user's sandbox workspace. */
export async function listWorkspaceFiles(userId: string): Promise<WorkspaceFile[]> {
  const { files } = await json<{ files: WorkspaceFile[] }>(
    await fetch(`/api/workspace/files?userId=${encodeURIComponent(userId)}`),
  )
  return files
}

/** Download URL for one workspace file. Served as an attachment by the API. */
export function workspaceFileUrl(userId: string, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  return `/api/workspace/files/${encoded}?userId=${encodeURIComponent(userId)}`
}

/** Read-only Postgres connections this browser has added. */
export async function listConnections(userId: string): Promise<DbConnectionRow[]> {
  const { connections } = await json<{ connections: DbConnectionRow[] }>(
    await fetch(`/api/databases?userId=${encodeURIComponent(userId)}`),
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
  userId: string,
  name: string,
  url: string,
): Promise<{ connection?: DbConnectionRow; error?: string }> {
  const res = await fetch(`/api/databases?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, url }),
  })
  return await res.json()
}

export async function refreshConnection(userId: string, id: string): Promise<void> {
  await fetch(
    `/api/databases/${encodeURIComponent(id)}/refresh?userId=${encodeURIComponent(userId)}`,
    { method: 'POST' },
  )
}

export async function deleteConnection(userId: string, id: string): Promise<void> {
  await fetch(`/api/databases/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}
