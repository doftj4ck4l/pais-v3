import type { ConversationDetail, ConversationRow, DocumentRow, IngestResult, Meta } from '@/lib/types'

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
