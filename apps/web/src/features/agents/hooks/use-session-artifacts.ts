import { useEffect, useMemo, useState } from 'react'
import { listImages, listWorkspaceFiles } from '@/shared/api/api'
import { withAppBase } from '@/shared/lib/app-base'
import { sessionArtifacts, transcriptKey } from '@/features/agents/lib/artifacts'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { AgentRun } from '@/features/agents/hooks/use-agent-board'
import type { Item, WorkspaceFile } from '@/shared/lib/types'

/** Stable empty transcript, so a chat with no agent open is not a new array each render. */
const EMPTY: Item[] = []

/** A file and its size, as the panel draws it. */
export type SessionFile = { path: string; bytes?: number }

export type SessionArtifactState = {
  /** `/api/images/<id>`, oldest first. */
  images: string[]
  files: SessionFile[]
  count: number
}

/**
 * Everything one chat produced: pictures and files, in one place.
 *
 * Three sources, because no one of them is complete:
 *
 * - **The transcript** is live and ordered, and is the only thing that knows
 *   which run a file belongs to. It sees anything `write`, `edit` or
 *   `share_file` named.
 * - **The workspace listing, windowed to the run** catches what `bash` made. A
 *   spreadsheet written by a python script is named nowhere in the transcript,
 *   and it is exactly the file the user was promised. Attributing it by time
 *   can misfile a write from a second agent running in parallel — a file that
 *   really was produced while you watched, shown to you, is the better error
 *   than the finished work being invisible.
 * - **The images table**, for a generation the model never embedded — a run
 *   that says "I've made it" and shows nothing.
 *
 * The counting lives here rather than in the panel so the header's badge and
 * the panel's contents cannot disagree.
 */
export function useSessionArtifacts(agent: AgentRun | null): SessionArtifactState {
  const scope = useScope()
  const [rows, setRows] = useState<WorkspaceFile[]>([])
  const [stored, setStored] = useState<string[]>([])

  const conversationId = agent?.conversationId ?? null
  const running = agent?.status === 'running'
  // Keyed on the transcript's content, not the array: the board streams into
  // one array in place, so its identity never changes mid-run.
  const items = agent?.items ?? EMPTY
  const contentKey = transcriptKey(items)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fromTranscript = useMemo(() => sessionArtifacts(items), [contentKey])

  // Both listings change only when a run writes something, so they are fetched
  // when the open chat changes, when the transcript names something new, and
  // once more when the run settles — never on a timer.
  const foundKey = `${fromTranscript.images.join(' ')}|${fromTranscript.files.join(' ')}`
  useEffect(() => {
    if (!conversationId) {
      setRows([])
      setStored([])
      return
    }
    let live = true
    void listWorkspaceFiles(scope)
      .then((files) => live && setRows(files))
      .catch(() => {
        // The transcript's own paths still list, without their sizes.
      })
    void listImages(scope, conversationId)
      .then((images) => live && setStored(images.map((i) => withAppBase(`/api/images/${i.id}`)).reverse()))
      .catch(() => {
        // Same: whatever the transcript named is already on screen.
      })
    return () => {
      live = false
    }
  }, [conversationId, foundKey, running, scope])

  return useMemo(() => {
    const seenImages = new Set(fromTranscript.images)
    const images = [...fromTranscript.images, ...stored.filter((url) => !seenImages.has(url))]

    // The run's own window, with a little slack at the end: a file flushed as
    // the last turn returns is still this run's.
    const from = agent?.startedAt ?? 0
    const to = from + (agent?.elapsed ?? 0) + 2000
    const bytes = new Map(rows.map((r) => [r.path, r.bytes]))

    const paths = [...fromTranscript.files]
    for (const row of rows) {
      if (row.modifiedAt >= from && row.modifiedAt <= to && !paths.includes(row.path)) {
        paths.push(row.path)
      }
    }

    const files = paths.map((path) => ({ path, bytes: bytes.get(path) }))
    return { images, files, count: images.length + files.length }
  }, [agent?.startedAt, agent?.elapsed, fromTranscript, rows, stored])
}
