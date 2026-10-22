import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  answerQuestion,
  apiFetch,
  deleteConversation,
  fetchConversation,
  fetchMeta,
  listConversations,
  setConversationPinned,
  stopRun,
} from '@/shared/api/api'
import { formatToolArgs, itemsFromRows, traceFromRows } from '@/features/agents/lib/transcript'
import {
  MAX_STREAM_RETRIES,
  STREAM_RETRY_BASE_MS,
  StreamHttpError,
  isRetryableStreamError,
  waitForRetry,
} from '@/features/agents/lib/stream-retry'
import {
  historyFrom,
  withDocumentReferenceNote,
} from '@/features/agents/lib/attachment-notes'
import {
  appendQueuedFollowUp,
  newQueuedFollowUpId,
  shiftQueuedFollowUp,
  shouldQueueFollowUp,
} from '@/features/agents/lib/follow-up-queue'
import type { QueuedFollowUp } from '@/features/agents/lib/follow-up-queue'
import type { Scope } from '@/shared/api/api'
import type {
  ConversationRow,
  Item,
  Meta,
  Slots,
  TraceLine,
  ChatAttachments,
  ConversationMode,
} from '@/shared/lib/types'

export type AgentStatus = 'running' | 'done' | 'stopped' | 'error'

/** One independently-running agent (1 agent = 1 task). */
export type AgentRun = {
  id: string
  /** The stored row backing this agent, once the server has created it. */
  conversationId: string | null
  modelId: string
  mode: ConversationMode
  task: string
  status: AgentStatus
  pinned: boolean
  items: Item[]
  trace: TraceLine[]
  slots: Slots | null
  notice: string | null
  elapsed: number
  startedAt: number
  /** False for a restored agent whose transcript hasn't been fetched yet. */
  hydrated: boolean
  /** Context budget as of the last turn, once the server has reported it. */
  context: ContextUsage | null
  /**
   * An unanswered `ask_user` question. Set while the run is paused waiting for
   * the user to pick an option or type a reply; cleared once answered. Only one
   * at a time — the run blocks on it.
   */
  pendingQuestion: PendingQuestion | null
  /** Follow-ups waiting for the active turn to settle, in send order. */
  queuedFollowUps: QueuedFollowUp[]
}

export type PendingQuestion = {
  id: string
  question: string
  options: string[]
  kind: 'question' | 'approval'
}

/** Where each channel's open item sits in the transcript, while it streams. */
type StreamRef = {
  thinking: number | null
  text: number | null
  /** When the open reasoning block started, for its `Thought for …` label. */
  thinkingStart: number | null
}

function freshStream(): StreamRef {
  return { thinking: null, text: null, thinkingStart: null }
}

export type ContextUsage = {
  used: number
  window: number
  estimated: boolean
  compacted?: { fromTokens: number; toTokens: number; turnsSummarised: number }
}

/**
 * Rebuild the wire history from a rendered transcript.
 *
 * Only user and assistant text crosses the wire: tool calls and their results
 * are replayed server-side by the agent loop, and thinking is not part of the
 * conversation the model is given. Sending them back would double-count context
 * the server already accounts for.
 */
/**
 * AgentBoard: a multi-agent console. Each agent runs its own task on its own
 * model, streaming over an independent SSE connection in parallel. The UI
 * selects one agent to view while the sidebar lists them all with live status.
 *
 * Runs are persisted server-side, so the board is rehydrated from
 * /api/conversations on load and past agents come back after a refresh. Their
 * transcripts are fetched lazily, the first time you select one.
 *
 * Implementation note: every agent's stream mutates its own items array in a
 * ref, then flush() publishes a shallow copy into React state. SSE events for a
 * single agent are processed sequentially, so mutating its own array is safe;
 * parallel agents touch disjoint arrays.
 */
export function useAgentBoard(scope: Scope) {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [modelIdForNew, setModelIdForNew] = useState('pixel-simple-1')
  const [modeForNew, setModeForNew] = useState<ConversationMode>('work')
  // Chosen reasoning effort for a thinking model. Null when the selected model
  // has no adjustable effort; the server falls back to the model's default.
  const [effort, setEffort] = useState<string | null>(null)
  const [agents, setAgents] = useState<AgentRun[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runsCompleted, setRunsCompleted] = useState(0)

  const controllersRef = useRef<Map<string, AbortController>>(new Map())
  const itemsRef = useRef<Map<string, Item[]>>(new Map())
  const traceRef = useRef<Map<string, TraceLine[]>>(new Map())
  const streamRefs = useRef<Map<string, StreamRef>>(new Map())
  const queuedFollowUpsRef = useRef<Map<string, QueuedFollowUp[]>>(new Map())
  const conversationIdsRef = useRef<Map<string, string>>(new Map())
  const effortRef = useRef(effort)
  const agentsRef = useRef<AgentRun[]>([])

  useEffect(() => {
    agentsRef.current = agents
  })

  useEffect(() => {
    effortRef.current = effort
  }, [effort])

  // A finished run's generated title usually lands after the SSE stream has
  // closed, so nothing pushes it live. Once per settled run, refetch the
  // conversation listing a beat later and adopt any changed title. Only the
  // title is taken — the server rows never override live transcript state.
  useEffect(() => {
    if (!runsCompleted) return
    const timer = setTimeout(() => {
      void listConversations(scope)
        .then((rows) => {
          setAgents((prev) =>
            prev.map((agent) => {
              const row = agent.conversationId
                ? rows.find((r) => r.id === agent.conversationId)
                : undefined
              return row && row.title && row.title !== agent.task
                ? { ...agent, task: row.title }
                : agent
            }),
          )
        })
        .catch(() => {
          /* API down or nothing stored — the next load picks it up anyway */
        })
    }, 2_000)
    return () => clearTimeout(timer)
  }, [runsCompleted, scope])

  // Keep the effort in step with the model: a thinking model defaults to its own
  // default level, a plain model clears it. Runs when the model or the catalog
  // changes, so switching to an adjustable model shows its control pre-set and
  // switching away hides it.
  useEffect(() => {
    const model = meta?.models.find((m) => m.id === modelIdForNew)
    setEffort(model?.thinking ? model.thinking.default : null)
  }, [modelIdForNew, meta])

  // Publish an immutable items snapshot so memoized transcript rendering can
  // ignore timer-only agent updates without missing streamed content.
  const flush = useCallback((id: string) => {
    setAgents((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              items: [...(itemsRef.current.get(id) ?? a.items)],
              trace: traceRef.current.get(id) ?? a.trace,
            }
          : a,
      ),
    )
  }, [])

  const patchAgent = useCallback((id: string, patch: Partial<AgentRun>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }, [])

  useEffect(() => {
    fetchMeta()
      .then((d) => {
        setMeta(d)
        // Keep the preferred default, but fall back if the gateway doesn't serve it.
        if (d.models.length) {
          setModelIdForNew((m) => (d.models.some((x) => x.id === m) ? m : d.models[0].id))
        }
      })
      .catch(() => {
        /* API down — the composer surfaces the error on spawn */
      })
  }, [])

  // Bring back everything this workspace has run before, and do it again when
  // the workspace changes. Keyed by id rather than a boolean because React
  // StrictMode runs effects twice in dev, which would restore each run twice.
  const restoredForRef = useRef<string | null>(null)
  useEffect(() => {
    const workspaceId = scope.workspaceId
    // Null until the first workspace list arrives; restoring now would ask the
    // server for a scope it would have to guess at.
    if (!workspaceId) return
    if (restoredForRef.current === workspaceId) return
    const switching = restoredForRef.current !== null
    restoredForRef.current = workspaceId

    if (switching) {
      // The previous workspace's agents are not this workspace's agents, so the
      // board starts empty. In-flight runs are deliberately left alone: the API
      // ties the run to the request signal, so aborting here would kill a
      // working agent merely because the user looked at something else. Their
      // events land on ids the board no longer holds, which is a no-op, and
      // switching back restores them from the transcript.
      itemsRef.current.clear()
      traceRef.current.clear()
      streamRefs.current.clear()
      queuedFollowUpsRef.current.clear()
      conversationIdsRef.current.clear()
      setAgents([])
      setSelectedId(null)
    }

    listConversations(scope)
      .then((rows) => {
        if (!rows.length) return
        const restored = rows.map(toRestoredAgent)
        for (const agent of restored) {
          itemsRef.current.set(agent.id, [...agent.items])
          traceRef.current.set(agent.id, [])
          queuedFollowUpsRef.current.set(agent.id, [])
          if (agent.conversationId) conversationIdsRef.current.set(agent.id, agent.conversationId)
        }
        setAgents((prev) => {
          const known = new Set(prev.map((a) => a.id))
          return [...restored.filter((a) => !known.has(a.id)), ...prev]
        })
      })
      .catch(() => {
        /* nothing stored, or API down */
      })
  }, [scope])

  // Live elapsed per running agent. Skipped entirely when nothing is running.
  useEffect(() => {
    const id = setInterval(() => {
      if (!agentsRef.current.some((a) => a.status === 'running')) return
      setAgents((prev) =>
        prev.map((a) => (a.status === 'running' ? { ...a, elapsed: Date.now() - a.startedAt } : a)),
      )
    }, 100)
    return () => clearInterval(id)
  }, [])

  /** Fetch a restored agent's transcript the first time it is opened. */
  const hydrate = useCallback(
    async (agent: AgentRun) => {
      if (agent.hydrated || !agent.conversationId) return
      try {
        const detail = await fetchConversation(agent.conversationId)
        const items = itemsFromRows(detail.messages)
        const trace = traceFromRows(detail.traces)
        itemsRef.current.set(agent.id, [...items])
        traceRef.current.set(agent.id, [...trace])
        patchAgent(agent.id, { items, trace, hydrated: true })
      } catch {
        patchAgent(agent.id, {
          hydrated: true,
          notice: 'Could not load this run from storage.',
        })
      }
    },
    [patchAgent],
  )

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id)
      if (!id) return
      const agent = agentsRef.current.find((a) => a.id === id)
      if (agent) void hydrate(agent)
    },
    [hydrate],
  )

  const stop = useCallback(
    (id: string) => {
      // Two things, because neither stops the run alone: abort this browser's
      // fetch so it stops reading, and tell the server to cancel the run —
      // closing the connection does not reach the pi loop on this runtime.
      const agent = agentsRef.current.find((a) => a.id === id)
      controllersRef.current.get(id)?.abort()
      if (agent?.conversationId) void stopRun(scope, agent.conversationId)
      patchAgent(id, { status: 'stopped', notice: 'Run stopped.', pendingQuestion: null })
    },
    [patchAgent, scope],
  )

  /**
   * Answer an `ask_user` question the run is blocked on. Sends the reply to the
   * server (which unblocks the run) and clears the prompt. The run then streams
   * on, so no local status change is needed.
   */
  const answer = useCallback(
    async (id: string, text: string) => {
      const agent = agentsRef.current.find((a) => a.id === id)
      const q = agent?.pendingQuestion
      if (!agent || !q || !agent.conversationId) return
      try {
        await answerQuestion(scope, agent.conversationId, q.id, text)
        patchAgent(id, { pendingQuestion: null, notice: null })
      } catch {
        patchAgent(id, { notice: 'Could not deliver your answer. Please try again.' })
      }
    },
    [patchAgent, scope],
  )

  const remove = useCallback((id: string) => {
    const agent = agentsRef.current.find((a) => a.id === id)
    controllersRef.current.get(id)?.abort()
    controllersRef.current.delete(id)
    itemsRef.current.delete(id)
    traceRef.current.delete(id)
    streamRefs.current.delete(id)
    queuedFollowUpsRef.current.delete(id)
    conversationIdsRef.current.delete(id)
    if (agent?.conversationId) void deleteConversation(agent.conversationId)

    setAgents((prev) => prev.filter((a) => a.id !== id))
    setSelectedId((cur) => {
      if (cur !== id) return cur
      return agentsRef.current.find((a) => a.id !== id)?.id ?? null
    })
  }, [])

  const setPinned = useCallback(
    async (id: string, pinned: boolean) => {
      const agent = agentsRef.current.find((candidate) => candidate.id === id)
      const conversationId = conversationIdsRef.current.get(id) ?? agent?.conversationId
      if (!agent || !conversationId) return

      patchAgent(id, { pinned, notice: null })
      try {
        await setConversationPinned(scope, conversationId, pinned)
      } catch {
        patchAgent(id, {
          pinned: !pinned,
          notice: 'Could not update this chat. Please try again.',
        })
      }
    },
    [patchAgent, scope],
  )

  const clearAll = useCallback(() => {
    for (const [, controller] of controllersRef.current) controller.abort()
    for (const agent of agentsRef.current) {
      if (agent.conversationId) void deleteConversation(agent.conversationId)
    }
    controllersRef.current.clear()
    itemsRef.current.clear()
    traceRef.current.clear()
    streamRefs.current.clear()
    queuedFollowUpsRef.current.clear()
    conversationIdsRef.current.clear()
    setAgents([])
    setSelectedId(null)
  }, [])

  /** Spawn a new agent running `task` on `modelId`. Returns the new agent id. */
  function spawn(
    task: string,
    modelId: string,
    attachments: ChatAttachments = { images: [], dataFiles: [] },
    mode: ConversationMode = 'work',
  ) {
    const { images, dataFiles, documents = [] } = attachments
    const id = Math.random().toString(36).slice(2, 8)
    const agent: AgentRun = {
      id,
      conversationId: null,
      modelId,
      mode,
      task,
      status: 'running',
      pinned: false,
      items: [
        {
          kind: 'user',
          text: withDocumentReferenceNote(task, documents.map((document) => document.id)),
          images: images.map((i) => i.url),
          files: dataFiles,
        },
      ],
      trace: [],
      slots: null,
      notice: null,
      elapsed: 0,
      startedAt: Date.now(),
      hydrated: true,
      context: null,
      pendingQuestion: null,
      queuedFollowUps: [],
    }
    itemsRef.current.set(id, [...agent.items])
    traceRef.current.set(id, [])
    streamRefs.current.set(id, freshStream())
    queuedFollowUpsRef.current.set(id, [])
    // Prepended, because the list is newest-first: restored runs arrive in that
    // order and the reader's own new chat is the newest thing there is.
    // Appending put it under everything else in Today, which read as the run
    // having gone somewhere else.
    setAgents((prev) => [agent, ...prev])
    setSelectedId(id)
    void run(id, agent, [{ role: 'user', content: agent.task }], attachments)
    return id
  }

  /**
   * Append a turn to an existing agent and re-run it with the whole thread.
   *
   * The full transcript goes up so the model has the conversation, and the
   * conversation id goes with it so the server extends that row instead of
   * opening a new one.
   */
  function sendFollowUp(
    agentId: string,
    text: string,
    attachments: ChatAttachments = { images: [], dataFiles: [] },
  ) {
    const agent = agentsRef.current.find((a) => a.id === agentId)
    if (!agent) return

    const followUp: QueuedFollowUp = {
      id: newQueuedFollowUpId(),
      text,
      attachments,
    }
    if (shouldQueueFollowUp(agent.status === 'running', controllersRef.current.has(agentId))) {
      const queue = appendQueuedFollowUp(
        queuedFollowUpsRef.current.get(agentId) ?? [],
        followUp,
      )
      queuedFollowUpsRef.current.set(agentId, queue)
      patchAgent(agentId, { queuedFollowUps: queue, notice: null })
      return
    }

    startFollowUp(agent, followUp)
  }

  function startFollowUp(agent: AgentRun, followUp: QueuedFollowUp) {
    const { images, dataFiles, documents = [] } = followUp.attachments
    const { text } = followUp

    const items = itemsRef.current.get(agent.id)
    if (!items) return

    const history = [...historyFrom(items), { role: 'user' as const, content: text }]
    items.push({
      kind: 'user',
      text: withDocumentReferenceNote(text, documents.map((document) => document.id)),
      images: images.map((i) => i.url),
      files: dataFiles,
    })
    streamRefs.current.set(agent.id, freshStream())
    patchAgent(agent.id, {
      status: 'running',
      notice: null,
      items: [...items],
      startedAt: Date.now(),
      elapsed: 0,
    })
    void run(
      agent.id,
      {
        ...agent,
        conversationId: conversationIdsRef.current.get(agent.id) ?? agent.conversationId,
      },
      history,
      followUp.attachments,
    )
  }

  const removeQueuedFollowUp = useCallback(
    (agentId: string, followUpId: string) => {
      const queue = (queuedFollowUpsRef.current.get(agentId) ?? [])
        .filter((followUp) => followUp.id !== followUpId)
      queuedFollowUpsRef.current.set(agentId, queue)
      patchAgent(agentId, { queuedFollowUps: queue })
    },
    [patchAgent],
  )

  function runNextQueuedFollowUp(id: string) {
    const agent = agentsRef.current.find((candidate) => candidate.id === id)
    if (!agent) return
    const { next, remaining } = shiftQueuedFollowUp(queuedFollowUpsRef.current.get(id) ?? [])
    if (!next) return
    queuedFollowUpsRef.current.set(id, remaining)
    patchAgent(id, { queuedFollowUps: remaining })
    startFollowUp(agent, next)
  }

  async function run(
    id: string,
    seed: AgentRun,
    history: { role: 'user' | 'assistant'; content: string; filePaths?: string[] }[],
    attachments: ChatAttachments = { images: [], dataFiles: [] },
  ) {
    const controller = new AbortController()
    controllersRef.current.set(id, controller)

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          // The first attempt sends the request the caller built. A reconnect
          // rebuilds it from what has already streamed, so the model continues
          // the conversation instead of starting it over.
          const retryHistory =
            attempt === 0 ? history : historyFrom(itemsRef.current.get(id) ?? [])
          await streamOnce(
            id,
            seed,
            retryHistory,
            attachments,
            controller.signal,
            attempt > 0,
          )
          break
        } catch (e) {
          const err = e as Error
          if (
            err.name === 'AbortError' ||
            !isRetryableStreamError(err) ||
            attempt >= MAX_STREAM_RETRIES
          ) {
            throw e
          }
          patchAgent(id, { notice: 'Connection dropped — reconnecting…' })
          await waitForRetry(STREAM_RETRY_BASE_MS * 2 ** attempt, controller.signal)
        }
      }
    } catch (e) {
      const err = e as Error
      if (err.name !== 'AbortError') {
        patchAgent(id, { status: 'error', notice: `Request failed: ${err.message}` })
      }
    } finally {
      controllersRef.current.delete(id)
      setAgents((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, status: a.status === 'running' ? 'done' : a.status, pendingQuestion: null }
            : a,
        ),
      )
      // A run is the only thing that writes to the workspace, so its end is the
      // one moment worth re-listing files — cheaper and more accurate than polling.
      setRunsCompleted((n) => n + 1)
      runNextQueuedFollowUp(id)
    }
  }

  /** One `POST /api/chat` attempt, streamed to completion or to its first error. */
  async function streamOnce(
    id: string,
    seed: AgentRun,
    history: { role: 'user' | 'assistant'; content: string; filePaths?: string[] }[],
    attachments: ChatAttachments,
    signal: AbortSignal,
    resume: boolean,
  ) {
    const { images, dataFiles, documents = [] } = attachments
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // A reconnect must extend the same conversation the first attempt opened.
        conversationId:
          conversationIdsRef.current.get(id) ?? seed.conversationId ?? undefined,
        // The aborted attempt already persisted the user turn, so the server must
        // record the continuation alone rather than the turn again.
        resume: resume || undefined,
        mode: seed.mode,
        modelId: seed.modelId,
        workspaceId: scope.workspaceId ?? undefined,
        // Only meaningful for a thinking model; null on every other, where the
        // server ignores it anyway.
        reasoningEffort: effortRef.current ?? undefined,
        messages: history,
        // Ids only. The bytes are already in the bucket; the server turns
        // these into a note on the user message telling the model to call
        // read_image.
        imageIds: images.length ? images.map((i) => i.id) : undefined,
        documentIds: documents.length ? documents.map((document) => document.id) : undefined,
        filePaths: dataFiles.length ? dataFiles.map((file) => file.path) : undefined,
      }),
      signal,
    })
    if (!res.ok || !res.body) throw new StreamHttpError(res.status)
    // The connection is back; drop the reconnect notice the retry loop set. A
    // notice the server sends later still lands, because it arrives after this.
    patchAgent(id, { notice: null })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const chunk of parts) {
        const line = chunk.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const data = line.slice(5).trim()
        if (!data) continue
        let event: Record<string, any>
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        handleEvent(id, event)
      }
    }
  }

  function handleEvent(id: string, event: Record<string, any>) {
    const ref = streamRefs.current.get(id)
    if (!ref) return
    const items = itemsRef.current.get(id)!
    const trace = traceRef.current.get(id)!

    switch (event.type) {
      case 'conversation':
        conversationIdsRef.current.set(id, event.id)
        patchAgent(id, { conversationId: event.id })
        return

      case 'title':
        // The server's background title job landed while the stream was open.
        // The sidebar renders `task`, so the generated title replaces the raw
        // first message here directly — no refetch needed.
        patchAgent(id, { task: event.title })
        return

      case 'ask_user':
        // The run is now blocked server-side awaiting this answer. Surface it;
        // the composer renders the options and calls `answer`.
        patchAgent(id, {
          pendingQuestion: {
            id: event.id,
            question: event.question,
            options: event.options ?? [],
            kind: event.kind ?? 'question',
          },
        })
        return

      case 'context':
        patchAgent(id, {
          context: {
            used: event.used,
            window: event.window,
            estimated: event.estimated,
            compacted: event.compacted,
          },
        })
        return

      case 'iteration':
        ref.thinking = null
        ref.text = null
        items.push({ kind: 'iteration', n: event.iteration })
        break

      case 'reasoning': {
        // Nothing marks the end of a reasoning block, so the duration is
        // restamped on every delta: it counts up live and is already final by
        // the time the next event closes the block.
        const opening = ref.thinking == null || items[ref.thinking]?.kind !== 'thinking'
        if (opening) ref.thinkingStart = Date.now()
        ref.thinking = pushDelta(items, ref, 'thinking', event.delta)
        if (ref.thinking != null) {
          const block = items[ref.thinking] as Extract<Item, { kind: 'thinking' }>
          items[ref.thinking] = { ...block, ms: Date.now() - (ref.thinkingStart ?? Date.now()) }
        }
        break
      }

      case 'text':
        ref.text = pushDelta(items, ref, 'assistant', event.delta)
        break

      case 'tool_call':
        ref.thinking = null
        ref.text = null
        items.push({
          kind: 'tool',
          id: event.id,
          name: event.name,
          args: formatToolArgs(event.args),
        })
        break

      case 'tool_result': {
        // Pair on the call id, not the tool name: parallel calls to one tool
        // finish out of order, and matching the earliest unanswered call by
        // name showed each result under another call's arguments. Falls back to
        // the name walk for a stream that carries no id.
        const idx = items.findIndex((x) =>
          x.kind !== 'tool' || x.result !== undefined
            ? false
            : event.id !== undefined
              ? x.id === event.id
              : x.name === event.name,
        )
        if (idx >= 0) {
          items[idx] = {
            ...(items[idx] as Extract<Item, { kind: 'tool' }>),
            result: event.content,
            ms: event.ms,
            ok: event.ok,
          }
        }
        break
      }

      case 'slots':
        patchAgent(id, {
          slots:
            event.mode === 'tools'
              ? { tools: event.tools ?? [] }
              : { steer: event.steer, followUp: event.followUp },
        })
        break

      case 'trace':
        trace.push({ ts: Date.now(), step: event.step, fields: event.fields })
        break

      case 'warn':
        patchAgent(id, { notice: event.message })
        break

      case 'error':
        patchAgent(id, { status: 'error', notice: `Error: ${event.message}` })
        break
    }
    flush(id)
  }

  function pushDelta(
    items: Item[],
    ref: StreamRef,
    kind: 'thinking' | 'assistant',
    delta: string,
  ): number | null {
    const key = kind === 'thinking' ? 'thinking' : 'text'
    const idx = ref[key]
    if (idx != null && items[idx]?.kind === kind) {
      const existing = items[idx] as Extract<Item, { kind: typeof kind }>
      if (kind === 'thinking') {
        items[idx] = { kind: 'thinking', text: existing.text + delta }
      } else {
        items[idx] = { kind: 'assistant', text: existing.text + delta }
      }
    } else {
      items.push({ kind, text: delta })
      ref[key] = items.length - 1
    }
    return ref[key]
  }

  const dismissNotice = useCallback(
    (id: string) => patchAgent(id, { notice: null }),
    [patchAgent],
  )

  const selected = agents.find((a) => a.id === selectedId) ?? null

  return {
    meta,
    modelIdForNew,
    setModelIdForNew,
    modeForNew,
    setModeForNew,
    effort,
    setEffort,
    agents,
    selected,
    selectedId,
    select,
    runsCompleted,
    spawn,
    sendFollowUp,
    removeQueuedFollowUp,
    stop,
    answer,
    setPinned,
    remove,
    dismissNotice,
    clearAll,
  }
}

/**
 * A stored run, as an agent. The transcript starts as just the task — the rest
 * is fetched when the agent is opened.
 */
function toRestoredAgent(row: ConversationRow): AgentRun {
  // A row still marked `running` means the server went away mid-run.
  const status: AgentStatus = row.status === 'running' ? 'stopped' : row.status
  return {
    id: row.id,
    conversationId: row.id,
    modelId: row.modelId,
    // This deployment is Work-only; legacy chat rows display as Work too.
    mode: 'work',
    task: row.title,
    status,
    pinned: row.pinned,
    items: [{ kind: 'user', text: row.title }],
    trace: [],
    slots: null,
    notice: null,
    elapsed: Math.max(0, row.updatedAt - row.createdAt),
    startedAt: row.createdAt,
    hydrated: false,
    context: null,
    pendingQuestion: null,
    queuedFollowUps: [],
  }
}

/** Everything the console does with agents, as one value. */
export type AgentBoard = ReturnType<typeof useAgentBoard>

/**
 * The board lives above the router, not inside the chat page.
 *
 * A run is an open SSE connection held in this hook's refs. Mounting the hook
 * per route meant that opening Docs mid-run unmounted the only thing listening
 * to it: the stream kept arriving, and the answer landed in a component nobody
 * would ever see again. Navigation is not a reason to lose a run.
 */
export const AgentBoardContext = createContext<AgentBoard | null>(null)

export function useBoard(): AgentBoard {
  const value = useContext(AgentBoardContext)
  if (!value) throw new Error('useBoard must be used inside an AgentBoardContext.Provider')
  return value
}
