import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  createAgentDefinition,
  deleteAgentDefinition,
  fetchMeta,
  listAgentDefinitions,
  previewAgent,
  rotateAgentToken,
  updateAgentDefinition,
  type AgentDefinitionInput,
} from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { AgentDefinition, Meta, Model } from '@/shared/lib/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { Spinner } from '@/shared/ui/spinner'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { ModelLogo } from '@/shared/components/model-logo'
import { cn } from '@/shared/lib/utils'

const STARTER_PROMPT =
  'You are a helpful assistant. Give clear, practical answers and ask one short question when important context is missing.'

const initialDraft = (modelId = ''): AgentDefinitionInput => ({
  name: '',
  systemPrompt: STARTER_PROMPT,
  modelId,
})

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

type RequestTicket = {
  generation: number
  workspaceId: string | null
  selectedId: string | null
}

export function AgentBuilder() {
  const scope = useScope()
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [meta, setMeta] = useState<Meta>({ harnesses: [], models: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDefinitionInput>(initialDraft())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ agentId: string; token: string } | null>(null)
  const [copied, setCopied] = useState<'key' | 'curl' | null>(null)
  const [previewInput, setPreviewInput] = useState('')
  const [previewReply, setPreviewReply] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | 'rotate' | null>(null)
  const agentsRef = useRef<AgentDefinition[]>([])
  const generationRef = useRef(0)
  const mountedRef = useRef(false)
  const workspaceIdRef = useRef(scope.workspaceId)
  const selectedIdRef = useRef<string | null>(null)

  const captureRequest = useCallback(
    (): RequestTicket => ({
      generation: generationRef.current,
      workspaceId: workspaceIdRef.current,
      selectedId: selectedIdRef.current,
    }),
    [],
  )

  const requestMatchesScope = useCallback(
    (ticket: RequestTicket) =>
      mountedRef.current && workspaceIdRef.current === ticket.workspaceId,
    [],
  )

  const requestMatchesSelection = useCallback(
    (ticket: RequestTicket) =>
      requestMatchesScope(ticket) &&
      generationRef.current === ticket.generation &&
      selectedIdRef.current === ticket.selectedId,
    [requestMatchesScope],
  )

  const mutateAgents = useCallback((update: (rows: AgentDefinition[]) => AgentDefinition[]) => {
    const next = update(agentsRef.current)
    agentsRef.current = next
    setAgents(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

  useEffect(() => {
    let live = true
    generationRef.current += 1
    workspaceIdRef.current = scope.workspaceId
    selectedIdRef.current = null
    setLoading(true)
    setAgents([])
    agentsRef.current = []
    setSelectedId(null)
    setSecret(null)
    setBusy(false)
    setPreviewing(false)
    setError(null)
    void Promise.all([listAgentDefinitions(scope), fetchMeta()])
      .then(([rows, catalog]) => {
        if (!live) return
        setAgents(rows)
        agentsRef.current = rows
        setMeta(catalog)
        const nextId = rows[0]?.id ?? null
        selectedIdRef.current = nextId
        setSelectedId(nextId)
        if (rows[0]) {
          setDraft({ name: rows[0].name, systemPrompt: rows[0].systemPrompt, modelId: rows[0].modelId })
        } else {
          setDraft(initialDraft(catalog.models.find((model) => model.ready)?.id ?? catalog.models[0]?.id))
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Could not load agents')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
      generationRef.current += 1
    }
  }, [scope])

  const current = agents.find((agent) => agent.id === selectedId) ?? null
  const creating = selectedId === null
  const models = meta.models

  const selectAgent = useCallback((agent: AgentDefinition) => {
    if (selectedIdRef.current !== agent.id) {
      generationRef.current += 1
      setSecret(null)
    }
    selectedIdRef.current = agent.id
    setSelectedId(agent.id)
    setDraft({ name: agent.name, systemPrompt: agent.systemPrompt, modelId: agent.modelId })
    setBusy(false)
    setPreviewing(false)
    setError(null)
    setPreviewReply(null)
    setPreviewInput('')
    setCopied(null)
  }, [])

  const startNew = useCallback(() => {
    generationRef.current += 1
    selectedIdRef.current = null
    setSelectedId(null)
    setDraft(initialDraft(models.find((model) => model.ready)?.id ?? models[0]?.id))
    setSecret(null)
    setError(null)
    setBusy(false)
    setPreviewing(false)
    setPreviewReply(null)
    setPreviewInput('')
  }, [models])

  const save = useCallback(async () => {
    const ticket = captureRequest()
    setBusy(true)
    setError(null)
    try {
      if (creating) {
        const result = await createAgentDefinition(scope, draft)
        if (!requestMatchesScope(ticket)) return
        mutateAgents((rows) => [result.agent, ...rows])
        if (!requestMatchesSelection(ticket)) return
        setBusy(false)
        generationRef.current += 1
        selectedIdRef.current = result.agent.id
        setSelectedId(result.agent.id)
        setSecret({ agentId: result.agent.id, token: result.token })
      } else if (current) {
        const updated = await updateAgentDefinition(scope, current.id, draft)
        if (!requestMatchesSelection(ticket)) return
        mutateAgents((rows) => rows.map((agent) => (agent.id === updated.id ? updated : agent)))
      }
    } catch (cause) {
      if (requestMatchesSelection(ticket)) {
        setError(cause instanceof Error ? cause.message : 'Could not save agent')
      }
    } finally {
      if (requestMatchesSelection(ticket)) setBusy(false)
    }
  }, [captureRequest, creating, current, draft, mutateAgents, requestMatchesScope, requestMatchesSelection, scope])

  const rotate = useCallback(async () => {
    if (!current) return
    const ticket = captureRequest()
    setBusy(true)
    setError(null)
    try {
      const result = await rotateAgentToken(scope, current.id)
      if (!requestMatchesSelection(ticket)) return
      mutateAgents((rows) => rows.map((agent) => (agent.id === result.agent.id ? result.agent : agent)))
      setSecret({ agentId: result.agent.id, token: result.token })
    } catch (cause) {
      if (requestMatchesSelection(ticket)) {
        setError(cause instanceof Error ? cause.message : 'Could not rotate API key')
      }
    } finally {
      if (requestMatchesSelection(ticket)) setBusy(false)
    }
  }, [captureRequest, current, mutateAgents, requestMatchesSelection, scope])

  const remove = useCallback(async () => {
    if (!current) return
    const ticket = captureRequest()
    const deletedId = current.id
    setBusy(true)
    setError(null)
    try {
      await deleteAgentDefinition(scope, deletedId)
      if (!requestMatchesScope(ticket)) return
      const remaining = agentsRef.current.filter((agent) => agent.id !== deletedId)
      mutateAgents((rows) => rows.filter((agent) => agent.id !== deletedId))
      if (requestMatchesSelection(ticket)) {
        const next = remaining[0] ?? null
        setBusy(false)
        generationRef.current += 1
        selectedIdRef.current = next?.id ?? null
        setSelectedId(next?.id ?? null)
        setSecret(null)
        setDraft(
          next
            ? { name: next.name, systemPrompt: next.systemPrompt, modelId: next.modelId }
            : initialDraft(models.find((model) => model.ready)?.id ?? models[0]?.id),
        )
      }
    } catch (cause) {
      if (requestMatchesSelection(ticket)) {
        setError(cause instanceof Error ? cause.message : 'Could not delete agent')
      }
    } finally {
      if (requestMatchesSelection(ticket)) setBusy(false)
    }
  }, [captureRequest, current, models, mutateAgents, requestMatchesScope, requestMatchesSelection, scope])

  const runPreview = useCallback(async () => {
    if (previewing || !current || !previewInput.trim()) return
    const ticket = captureRequest()
    setPreviewing(true)
    setPreviewReply(null)
    setError(null)
    try {
      const result = await previewAgent(scope, current.id, previewInput)
      if (requestMatchesSelection(ticket)) setPreviewReply(result.reply)
    } catch (cause) {
      if (requestMatchesSelection(ticket)) {
        setError(cause instanceof Error ? cause.message : 'The agent could not answer')
      }
    } finally {
      if (requestMatchesSelection(ticket)) setPreviewing(false)
    }
  }, [captureRequest, current, previewInput, previewing, requestMatchesSelection, scope])

  const visibleSecret = secret && secret.agentId === current?.id ? secret.token : null
  const endpoint = current
    ? `${window.location.origin}${current.endpoint}`
    : `${window.location.origin}/api/agents/invoke`
  const curl = useMemo(
    () =>
      [
        `curl -X POST '${endpoint}' \\`,
        `  -H 'Authorization: Bearer ${visibleSecret ?? 'YOUR_AGENT_API_KEY'}' \\`,
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"message":"Hello from Telegram"}'`,
      ].join('\n'),
    [endpoint, visibleSecret],
  )

  const copy = useCallback(async (value: string, kind: 'key' | 'curl') => {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied((active) => (active === kind ? null : active)), 1600)
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground">
        <Spinner className="size-4" />
        <span>Loading agent builder…</span>
      </div>
    )
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.8fr)] xl:gap-7">
      <aside className="min-w-0 lg:sticky lg:top-0">
        <div className="mb-3 flex flex-col items-stretch gap-3 min-[28rem]:flex-row min-[28rem]:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Your agents</h2>
            <p className="text-sm text-muted-foreground">
              {agents.length} configured in this workspace
            </p>
          </div>
          <Button size="sm" className="w-full min-[28rem]:w-auto" onClick={startNew}>
            <PlusIcon /> New agent
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          {agents.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              model={models.find((model) => model.id === agent.modelId)}
              active={!creating && agent.id === selectedId}
              onSelect={() => selectAgent(agent)}
            />
          ))}
        </div>
      </aside>

      {creating || current ? (
        <section className="min-w-0 space-y-5">
          <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="label mb-1 text-muted-foreground">
                {creating ? 'New prompt agent' : 'Agent definition'}
              </p>
              <h2 className="text-xl font-semibold tracking-tight">
                {creating ? 'Give this agent a job' : current?.name}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {!creating && current ? (
                <Button variant="ghost" size="sm" onClick={() => setConfirm('delete')} disabled={busy}>
                  <Trash2Icon /> Delete
                </Button>
              ) : null}
              <Button size="sm" onClick={() => void save()} disabled={busy || !draft.modelId}>
                {busy ? <Spinner /> : <CheckIcon />}
                {creating ? 'Create agent' : 'Save changes'}
              </Button>
            </div>
          </header>

          {error ? (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={draft.name}
                  maxLength={80}
                  placeholder="Customer support"
                  onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-model">Model</Label>
                <Select
                  value={draft.modelId}
                  onValueChange={(modelId) => setDraft((value) => ({ ...value, modelId }))}
                >
                  <SelectTrigger id="agent-model" className="w-full">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id} disabled={!model.ready}>
                        {model.label}{!model.ready ? ' · not configured' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="agent-prompt">System prompt</Label>
                  <span className="readout text-muted-foreground">{draft.systemPrompt.length.toLocaleString()} / 12,000</span>
                </div>
                <Textarea
                  id="agent-prompt"
                  value={draft.systemPrompt}
                  maxLength={12_000}
                  className="min-h-52 resize-y leading-relaxed"
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, systemPrompt: event.target.value }))
                  }
                />
                <p className="text-sm text-muted-foreground">
                  This is the agent’s standing instruction. API calls send this prompt, optional chat history, and the new message—no workspace tools or documents yet.
                </p>
              </div>
            </div>
          </div>

          {!creating && current ? (
            <>
              <ApiCard
                agent={current}
                endpoint={endpoint}
                token={visibleSecret}
                curl={curl}
                copied={copied}
                busy={busy}
                onCopy={copy}
                onRotate={() => setConfirm('rotate')}
              />
              <PreviewCard
                value={previewInput}
                reply={previewReply}
                busy={previewing}
                onChange={setPreviewInput}
                onSend={() => void runPreview()}
              />
            </>
          ) : (
            <div className="rounded-xl border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">
              Create the agent to reveal its API endpoint and open the preview chat.
            </div>
          )}
        </section>
      ) : (
        <div className="hidden min-h-96 items-center justify-center rounded-xl border border-dashed text-muted-foreground lg:flex">
          Choose an agent or create a new one.
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === 'delete' ? 'Delete this agent?' : 'Rotate this API key?'}
        description={
          confirm === 'delete'
            ? 'Its current API key will stop working immediately. This cannot be undone.'
            : 'The current key will stop working immediately. Update every bot or service that uses it.'
        }
        confirmLabel={confirm === 'delete' ? 'Delete agent' : 'Rotate key'}
        onConfirm={() => void (confirm === 'delete' ? remove() : rotate())}
      />
    </div>
  )
}

function AgentListItem({
  agent,
  model,
  active,
  onSelect,
}: {
  agent: AgentDefinition
  model?: Model
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
        'hover:border-foreground/25 hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        active && 'border-foreground/30 bg-muted/50',
      )}
    >
      <ModelLogo model={model} size={32} className="rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{agent.name}</span>
        <span className="mt-1 block truncate text-sm text-muted-foreground">
          {model?.label ?? agent.modelId}
        </span>
        <span className="readout mt-2 block text-muted-foreground">
          {agent.lastUsedAt ? `used ${time.format(agent.lastUsedAt)}` : 'not called yet'}
        </span>
      </span>
    </button>
  )
}

function ApiCard({
  agent,
  endpoint,
  token,
  curl,
  copied,
  busy,
  onCopy,
  onRotate,
}: {
  agent: AgentDefinition
  endpoint: string
  token: string | null
  curl: string
  copied: 'key' | 'curl' | null
  busy: boolean
  onCopy: (value: string, kind: 'key' | 'curl') => Promise<void>
  onRotate: () => void
}) {
  return (
    <section className="overflow-hidden rounded-xl bg-foreground text-background">
      <div className="flex flex-col gap-3 border-b border-background/15 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <p className="label flex items-center gap-1.5 text-background/60">
            <TerminalIcon className="size-3.5" /> External API
          </p>
          <h3 className="mt-1 text-lg font-semibold">Connect the agent</h3>
        </div>
        <div className="readout rounded-full border border-background/20 px-2.5 py-1 text-background/70">
          text only · stateless
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <p className="label mb-1.5 text-background/55">POST endpoint</p>
          <div className="readout overflow-x-auto rounded-lg border border-background/15 bg-background/5 px-3 py-2.5 text-background/90">
            {endpoint}
          </div>
        </div>

        {token ? (
          <div className="rounded-lg border border-background/25 bg-background/10 p-3">
            <div className="flex items-center gap-2">
              <KeyRoundIcon className="size-4 shrink-0" />
              <p className="min-w-0 flex-1 text-sm font-semibold">Copy this key now—it is shown once.</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void onCopy(token, 'key')}
              >
                {copied === 'key' ? <CheckIcon /> : <CopyIcon />}
                {copied === 'key' ? 'Copied' : 'Copy key'}
              </Button>
            </div>
            <p className="readout mt-3 overflow-x-auto whitespace-nowrap text-background/80">{token}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-background/15 px-3 py-2.5 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-sm text-background/70">
              Active key ends in <span className="readout text-background">{agent.tokenHint}</span>. The full key is hidden.
            </p>
            <Button variant="secondary" size="sm" onClick={onRotate} disabled={busy}>
              <RefreshCwIcon /> Generate new key
            </Button>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <p className="label text-background/55">Quick test</p>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-background/65 hover:text-background focus-visible:outline-none focus-visible:underline"
              onClick={() => void onCopy(curl, 'curl')}
            >
              {copied === 'curl' ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              {copied === 'curl' ? 'Copied' : 'Copy curl'}
            </button>
          </div>
          <pre className="readout overflow-x-auto rounded-lg border border-background/15 bg-background/5 p-3 leading-relaxed text-background/75">
            {curl}
          </pre>
        </div>
      </div>
    </section>
  )
}

function PreviewCard({
  value,
  reply,
  busy,
  onChange,
  onSend,
}: {
  value: string
  reply: string | null
  busy: boolean
  onChange: (value: string) => void
  onSend: () => void
}) {
  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
          <BotIcon className="size-4" />
        </span>
        <div>
          <h3 className="font-semibold">Try this agent</h3>
          <p className="text-sm text-muted-foreground">A private preview using the saved prompt.</p>
        </div>
      </div>

      {reply ? (
        <div aria-live="polite" className="mb-4 rounded-lg bg-muted/60 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
          {reply}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          placeholder="Ask the agent something…"
          className="min-h-20 resize-none"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <Button size="icon-lg" aria-label="Send preview" disabled={busy || !value.trim()} onClick={onSend}>
          {busy ? <Spinner /> : <SendIcon />}
        </Button>
      </div>
    </section>
  )
}
