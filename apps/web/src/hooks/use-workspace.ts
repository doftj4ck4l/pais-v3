import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  type Scope,
} from '@/lib/api'
import { getUserId } from '@/lib/user'
import type { WorkspaceRow } from '@/lib/types'

const KEY = 'salurai-workspace'

export type WorkspaceState = {
  workspaces: WorkspaceRow[]
  current: string | null
  scope: Scope
  loading: boolean
  setCurrent: (id: string) => void
  create: (name: string) => Promise<WorkspaceRow>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<{ error?: string }>
}

/**
 * Which workspace the console is showing.
 *
 * Persisted so a reload returns to the same body of work. The stored id is
 * verified against the server's list before use — it may name a workspace that
 * was removed in another tab, and silently showing an empty console would look
 * like data loss.
 */
export function useWorkspaceState(): WorkspaceState {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [current, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const userId = useMemo(() => getUserId(), [])

  const refresh = useCallback(async () => {
    const rows = await listWorkspaces(userId)
    setWorkspaces(rows)
    setCurrentId((prev) => {
      const saved = prev ?? localStorage.getItem(KEY)
      const valid = rows.some((w) => w.id === saved)
      return valid ? saved! : (rows[0]?.id ?? null)
    })
    setLoading(false)
    return rows
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setCurrent = useCallback((id: string) => {
    setCurrentId(id)
    localStorage.setItem(KEY, id)
  }, [])

  const create = useCallback(
    async (name: string) => {
      const created = await createWorkspace(userId, name)
      await refresh()
      setCurrent(created.id)
      return created
    },
    [userId, refresh, setCurrent],
  )

  const rename = useCallback(
    async (id: string, name: string) => {
      await renameWorkspace(userId, id, name)
      await refresh()
    },
    [userId, refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      const result = await deleteWorkspace(userId, id)
      if (result.error) return result
      // Land somewhere real before the panels re-fetch, or they would ask the
      // server about a workspace that no longer exists.
      const rows = await listWorkspaces(userId)
      setWorkspaces(rows)
      if (id === current) {
        const next = rows[0]?.id ?? null
        setCurrentId(next)
        if (next) localStorage.setItem(KEY, next)
      }
      return {}
    },
    [userId, current],
  )

  const scope = useMemo<Scope>(() => ({ userId, workspaceId: current }), [userId, current])

  return { workspaces, current, scope, loading, setCurrent, create, rename, remove }
}

/**
 * Shared so the resource panels can read the selection without it being drilled
 * through four levels of layout. Used directly as `<WorkspaceContext.Provider>`
 * rather than wrapped in a component, which keeps this file free of JSX and
 * exporting only hooks.
 */
export const WorkspaceContext = createContext<WorkspaceState | null>(null)

/**
 * The current workspace, for the panels that load their own data.
 *
 * A context rather than props because the resource panels already reach for
 * `getUserId()` as ambient state; the workspace is the other half of the same
 * question, and threading it through four levels of layout would not make it
 * any more explicit.
 */
export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside a WorkspaceProvider')
  return value
}

/** Just the scope, for the common case of a panel fetching its own rows. */
export function useScope(): Scope {
  return useWorkspace().scope
}
