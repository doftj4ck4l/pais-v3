import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteConversation,
  fetchConversation,
  fetchMeta,
  listConversations,
} from '@/lib/api'
import { formatToolArgs, itemsFromRows, traceFromRows } from '@/lib/transcript'
import { getUserId } from '@/lib/user'
import type { ConversationRow, Item, Meta, Slots, TraceLine } from '@/lib/types'

export type AgentStatus = 'running' | 'done' | 'stopped' | 'error'

/** One independently-running agent (1 agent = 1 task). */
export type AgentRun = {
  id: string
  /** The stored row backing this agent, once the server has created it. */
  conversationId: string | null
  modelId: string
  task: string
  status: AgentStatus
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
function historyFrom(items: Item[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const item of items) {
    if (item.kind === 'user') out.push({ role: 'user', content: item.text })
    else if (item.kind === 'assistant' && item.text.trim()) {
      out.push({ role: 'assistant', content: item.text })
    }
  }
  return out
}

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
export function useAgentBoard() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [harnessId, setHarnessId] = useState('')
  const [modelIdForNew, setModelIdForNew] = useState('gw-ds4-flash')
  const [agents, setAgents] = useState<AgentRun[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const userId = useRef(getUserId()).current
  const controllersRef = useRef<Map<string, AbortController>>(new Map())
  const itemsRef = useRef<Map<string, Item[]>>(new Map())
  const traceRef = useRef<Map<string, TraceLine[]>>(new Map())
  const streamRefs = useRef<Map<string, { thinking: number | null; text: number | null }>>(new Map())
  const harnessIdRef = useRef(harnessId)
  const agentsRef = useRef<AgentRun[]>([])

  useEffect(() => {
    agentsRef.current = agents
  })

  useEffect(() => {
    harnessIdRef.current = harnessId
  }, [harnessId])

  // Publish the (already mutated) refs into React state.
  const flush = useCallback((id: string) => {
    setAgents((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              items: itemsRef.current.get(id) ?? a.items,
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
        if (d.harnesses.length) setHarnessId((h) => h || d.harnesses[0].id)
        // Keep the preferred default, but fall back if the gateway doesn't serve it.
        if (d.models.length) {
          setModelIdForNew((m) => (d.models.some((x) => x.id === m) ? m : d.models[0].id))
        }
      })
      .catch(() => {
        /* API down — the composer surfaces the error on spawn */
      })
  }, [])

  // Bring back everything this browser has run before. Guarded because React
  // StrictMode runs effects twice in dev, which would restore each run twice.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true

    listConversations(userId)
      .then((rows) => {
        if (!rows.length) return
        const restored = rows.map(toRestoredAgent)
        for (const agent of restored) {
          itemsRef.current.set(agent.id, [...agent.items])
          traceRef.current.set(agent.id, [])
        }
        setAgents((prev) => {
          const known = new Set(prev.map((a) => a.id))
          return [...restored.filter((a) => !known.has(a.id)), ...prev]
        })
      })
      .catch(() => {
        /* nothing stored, or API down */
      })
  }, [userId])

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
      controllersRef.current.get(id)?.abort()
      patchAgent(id, { status: 'stopped', notice: 'Run stopped.' })
    },
    [patchAgent],
  )

  const remove = useCallback((id: string) => {
    const agent = agentsRef.current.find((a) => a.id === id)
    controllersRef.current.get(id)?.abort()
    controllersRef.current.delete(id)
    itemsRef.current.delete(id)
    traceRef.current.delete(id)
    streamRefs.current.delete(id)
    if (agent?.conversationId) void deleteConversation(agent.conversationId)

    setAgents((prev) => prev.filter((a) => a.id !== id))
    setSelectedId((cur) => {
      if (cur !== id) return cur
      return agentsRef.current.find((a) => a.id !== id)?.id ?? null
    })
  }, [])

  const clearAll = useCallback(() => {
    for (const [, controller] of controllersRef.current) controller.abort()
    for (const agent of agentsRef.current) {
      if (agent.conversationId) void deleteConversation(agent.conversationId)
    }
    controllersRef.current.clear()
    itemsRef.current.clear()
    traceRef.current.clear()
    streamRefs.current.clear()
    setAgents([])
    setSelectedId(null)
  }, [])

  /** Spawn a new agent running `task` on `modelId`. Returns the new agent id. */
  function spawn(task: string, modelId: string) {
    const id = Math.random().toString(36).slice(2, 8)
    const agent: AgentRun = {
      id,
      conversationId: null,
      modelId,
      task,
      status: 'running',
      items: [{ kind: 'user', text: task }],
      trace: [],
      slots: null,
      notice: null,
      elapsed: 0,
      startedAt: Date.now(),
      hydrated: true,
      context: null,
    }
    itemsRef.current.set(id, [...agent.items])
    traceRef.current.set(id, [])
    streamRefs.current.set(id, { thinking: null, text: null })
    setAgents((prev) => [...prev, agent])
    setSelectedId(id)
    void run(id, agent, [{ role: 'user', content: agent.task }])
    return id
  }

  /**
   * Append a turn to an existing agent and re-run it with the whole thread.
   *
   * The full transcript goes up so the model has the conversation, and the
   * conversation id goes with it so the server extends that row instead of
   * opening a new one.
   */
  function sendFollowUp(agentId: string, text: string) {
    const agent = agentsRef.current.find((a) => a.id === agentId)
    if (!agent || agent.status === 'running') return

    const items = itemsRef.current.get(agentId)
    if (!items) return

    const history = [...historyFrom(items), { role: 'user' as const, content: text }]
    items.push({ kind: 'user', text })
    streamRefs.current.set(agentId, { thinking: null, text: null })
    patchAgent(agentId, {
      status: 'running',
      notice: null,
      items: [...items],
      startedAt: Date.now(),
      elapsed: 0,
    })
    void run(agentId, agent, history)
  }

  async function run(
    id: string,
    seed: AgentRun,
    history: { role: 'user' | 'assistant'; content: string }[],
  ) {
    const controller = new AbortController()
    controllersRef.current.set(id, controller)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: seed.conversationId ?? undefined,
          harnessId: harnessIdRef.current,
          modelId: seed.modelId,
          userId,
          messages: history,
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

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
    } catch (e) {
      const err = e as Error
      if (err.name !== 'AbortError') {
        patchAgent(id, { status: 'error', notice: `Request failed: ${err.message}` })
      }
    } finally {
      controllersRef.current.delete(id)
      setAgents((prev) =>
        prev.map((a) => (a.id === id && a.status === 'running' ? { ...a, status: 'done' } : a)),
      )
    }
  }

  function handleEvent(id: string, event: Record<string, any>) {
    const ref = streamRefs.current.get(id)
    if (!ref) return
    const items = itemsRef.current.get(id)!
    const trace = traceRef.current.get(id)!

    switch (event.type) {
      case 'conversation':
        patchAgent(id, { conversationId: event.id })
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

      case 'reasoning':
        ref.thinking = pushDelta(items, ref, 'thinking', event.delta)
        break

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
        const idx = items.findIndex(
          (x) => x.kind === 'tool' && x.name === event.name && x.result === undefined,
        )
        if (idx >= 0) {
          items[idx] = { ...(items[idx] as Extract<Item, { kind: 'tool' }>), result: event.content }
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
    ref: { thinking: number | null; text: number | null },
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
    harnessId,
    setHarnessId,
    modelIdForNew,
    setModelIdForNew,
    agents,
    selected,
    selectedId,
    select,
    spawn,
    sendFollowUp,
    stop,
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
    task: row.title,
    status,
    items: [{ kind: 'user', text: row.title }],
    trace: [],
    slots: null,
    notice: null,
    elapsed: Math.max(0, row.updatedAt - row.createdAt),
    startedAt: row.createdAt,
    hydrated: false,
    context: null,
  }
}
