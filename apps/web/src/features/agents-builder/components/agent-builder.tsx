import { useEffect, useMemo, useState } from 'react'
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
import { APP_BASE } from '@/shared/lib/app-base'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { AgentDefinition, Meta, Model } from '@/shared/lib/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { Spinner } from '@/shared/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { ModelLogo } from '@/shared/components/model-logo'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'

/**
 * The agents a workspace can call from the outside.
 *
 * This is the same grid every resource page is: a header with a count and one
 * button, then a card per thing. A card opens the agent in a dialog where it is
 * viewed, edited, tested and connected — creating a new one opens the same
 * dialog empty, so there is one place an agent is shaped rather than a
 * master-detail split beside the list.
 *
 * Switching workspace remounts this whole tree (`ResourcePage` keys on the
 * workspace), so the in-flight-request bookkeeping the old split needed is
 * gone: a stale response lands in a component that no longer exists.
 */

const STARTER_PROMPT =
  'You are a helpful assistant. Give clear, practical answers and ask one short question when important context is missing.'

const draftFor = (agent: AgentDefinition | null, fallbackModelId = ''): AgentDefinitionInput =>
  agent
    ? { name: agent.name, systemPrompt: agent.systemPrompt, modelId: agent.modelId }
    : { name: '', systemPrompt: STARTER_PROMPT, modelId: fallbackModelId }

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The agent open in the dialog: an existing row, `'new'` for the empty form, or nothing. */
type Editing = AgentDefinition | 'new' | null

export function AgentBuilder() {
  const scope = useScope()
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [meta, setMeta] = useState<Meta>({ harnesses: [], models: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  // Shown once, right after a create or a rotate — the plaintext key never
  // comes back from the server again.
  const [freshToken, setFreshToken] = useState<{ agentId: string; token: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AgentDefinition | null>(null)

  const models = meta.models
  const defaultModelId = useMemo(
    () => models.find((model) => model.ready)?.id ?? models[0]?.id ?? '',
    [models],
  )

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    setEditing(null)
    setFreshToken(null)
    void Promise.all([listAgentDefinitions(scope), fetchMeta()])
      .then(([rows, catalog]) => {
        if (!live) return
        setAgents(rows)
        setMeta(catalog)
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Could not load agents')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [scope])

  // The agent currently open, resolved fresh from the list each render so an
  // edit reflects immediately without threading the updated row through state.
  const openAgent = editing && editing !== 'new'
    ? (agents.find((agent) => agent.id === editing.id) ?? editing)
    : null

  async function save(draft: AgentDefinitionInput) {
    if (editing === 'new') {
      const { agent, token } = await createAgentDefinition(scope, draft)
      setAgents((rows) => [agent, ...rows])
      setFreshToken({ agentId: agent.id, token })
      // Keep the dialog open on the created agent so its endpoint, one-time key
      // and preview are right there rather than a second click away.
      setEditing(agent)
    } else if (openAgent) {
      const updated = await updateAgentDefinition(scope, openAgent.id, draft)
      setAgents((rows) => rows.map((agent) => (agent.id === updated.id ? updated : agent)))
      setEditing(updated)
    }
  }

  async function rotate(agent: AgentDefinition) {
    const { agent: updated, token } = await rotateAgentToken(scope, agent.id)
    setAgents((rows) => rows.map((row) => (row.id === updated.id ? updated : row)))
    setFreshToken({ agentId: updated.id, token })
  }

  async function remove(agent: AgentDefinition) {
    await deleteAgentDefinition(scope, agent.id)
    setAgents((rows) => rows.filter((row) => row.id !== agent.id))
    if (editing !== 'new' && editing?.id === agent.id) setEditing(null)
  }

  const newButton = (
    <Button size="sm" onClick={() => setEditing('new')} disabled={!defaultModelId}>
      <PlusIcon data-icon="inline-start" /> New agent
    </Button>
  )

  return (
    <div className="flex flex-col">
      <PanelHeader
        summary={agents.length ? `${agents.length} configured` : null}
        busy={loading}
        action={agents.length ? newButton : null}
      />

      {loading ? null : agents.length === 0 ? (
        <PanelEmpty
          icon={BotIcon}
          title="No agents yet"
          description="Shape a text agent with a standing prompt, try it here, then call it from Telegram or any service over a simple HTTP endpoint."
          action={newButton}
        />
      ) : (
        <PanelGrid>
          {agents.map((agent) => (
            <ItemCard
              key={agent.id}
              onSelect={() => setEditing(agent)}
              label={`Edit ${agent.name}`}
              leading={
                <ModelLogo
                  model={models.find((model) => model.id === agent.modelId)}
                  size={30}
                  className="mt-0.5 rounded-md"
                />
              }
              title={agent.name || 'Untitled agent'}
              meta={
                <span className="flex flex-wrap gap-x-2">
                  <span>{models.find((model) => model.id === agent.modelId)?.label ?? agent.modelId}</span>
                  <span>{agent.lastUsedAt ? `used ${time.format(agent.lastUsedAt)}` : 'not called yet'}</span>
                </span>
              }
              actions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${agent.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmDelete(agent)}
                >
                  <Trash2Icon />
                </Button>
              }
            />
          ))}
        </PanelGrid>
      )}

      {error ? <p className="readout mt-3 whitespace-pre-wrap text-destructive">{error}</p> : null}

      <AgentDialog
        key={editing === 'new' ? 'new' : (openAgent?.id ?? 'closed')}
        open={editing !== null}
        agent={openAgent}
        models={models}
        defaultModelId={defaultModelId}
        token={freshToken && openAgent && freshToken.agentId === openAgent.id ? freshToken.token : null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={save}
        onRotate={rotate}
        onRequestDelete={setConfirmDelete}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title="Delete this agent?"
        description={`"${confirmDelete?.name || 'Untitled agent'}" and its API key will stop working immediately. This cannot be undone.`}
        confirmLabel="Delete agent"
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
      />
    </div>
  )
}

function AgentDialog({
  open,
  agent,
  models,
  defaultModelId,
  token,
  onOpenChange,
  onSave,
  onRotate,
  onRequestDelete,
}: {
  open: boolean
  /** The agent being edited, or null while creating a new one. */
  agent: AgentDefinition | null
  models: Model[]
  defaultModelId: string
  /** A just-minted plaintext key to reveal once, or null. */
  token: string | null
  onOpenChange: (open: boolean) => void
  onSave: (draft: AgentDefinitionInput) => Promise<void>
  onRotate: (agent: AgentDefinition) => Promise<void>
  onRequestDelete: (agent: AgentDefinition) => void
}) {
  const creating = agent === null
  const [draft, setDraft] = useState<AgentDefinitionInput>(() => draftFor(agent, defaultModelId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'key' | 'curl' | null>(null)
  const [previewInput, setPreviewInput] = useState('')
  const [previewReply, setPreviewReply] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

  // Reset the form whenever the dialog is (re)opened on a different agent. The
  // key on <AgentDialog> already remounts across agents, so this mostly covers
  // the create → created transition, where the same instance gains an agent.
  useEffect(() => {
    if (open) {
      setDraft(draftFor(agent, defaultModelId))
      setError(null)
      setPreviewReply(null)
      setPreviewInput('')
    }
  }, [open, agent, defaultModelId])

  const scope = useScope()

  const submit = async () => {
    if (busy || !draft.modelId) return
    setBusy(true)
    setError(null)
    try {
      await onSave(draft)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save agent')
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    if (!agent || busy) return
    setBusy(true)
    setError(null)
    try {
      await onRotate(agent)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rotate API key')
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async () => {
    if (previewing || !agent || !previewInput.trim()) return
    setPreviewing(true)
    setPreviewReply(null)
    setError(null)
    try {
      const result = await previewAgent(scope, agent.id, previewInput)
      setPreviewReply(result.reply)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agent could not answer')
    } finally {
      setPreviewing(false)
    }
  }

  const endpoint = agent
    ? `${window.location.origin}${APP_BASE}${agent.endpoint}`
    : `${window.location.origin}${APP_BASE}/api/agents/invoke`
  const curl = useMemo(
    () =>
      [
        `curl -X POST '${endpoint}' \\`,
        `  -H 'Authorization: Bearer ${token ?? 'YOUR_AGENT_API_KEY'}' \\`,
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"message":"Hello from Telegram"}'`,
      ].join('\n'),
    [endpoint, token],
  )

  const copy = async (value: string, kind: 'key' | 'curl') => {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied((active) => (active === kind ? null : active)), 1600)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle>{creating ? 'New agent' : agent?.name || 'Agent'}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'Give this agent a standing instruction and a model. You can test and connect it after creating.'
              : 'Edit the prompt, test it privately, and connect it to an external service.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          <form
            id="agent-form"
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={draft.name}
                maxLength={80}
                autoFocus={creating}
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
                      {model.label}
                      {!model.ready ? ' · not configured' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor="agent-prompt">System prompt</Label>
                <span className="readout text-muted-foreground">
                  {draft.systemPrompt.length.toLocaleString()} / 12,000
                </span>
              </div>
              <Textarea
                id="agent-prompt"
                value={draft.systemPrompt}
                maxLength={12_000}
                className="min-h-40 resize-y leading-relaxed"
                onChange={(event) =>
                  setDraft((value) => ({ ...value, systemPrompt: event.target.value }))
                }
              />
              <p className="text-sm text-muted-foreground">
                The agent&apos;s standing instruction. API calls send this prompt, optional chat
                history, and the new message — no workspace tools or documents yet.
              </p>
            </div>
          </form>

          {agent ? (
            <>
              <ApiCard
                agent={agent}
                endpoint={endpoint}
                token={token}
                curl={curl}
                copied={copied}
                busy={busy}
                onCopy={copy}
                onRotate={() => void rotate()}
              />
              <PreviewCard
                value={previewInput}
                reply={previewReply}
                busy={previewing}
                onChange={setPreviewInput}
                onSend={() => void runPreview()}
              />
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t px-5 py-4">
          {agent ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => onRequestDelete(agent)}
            >
              <Trash2Icon data-icon="inline-start" /> Delete
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
              {agent ? 'Close' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              form="agent-form"
              size="sm"
              disabled={busy || !draft.modelId}
            >
              {busy ? <Spinner /> : <CheckIcon />}
              {creating ? 'Create agent' : 'Save changes'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
      <div className="flex flex-col gap-3 border-b border-background/15 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="label flex items-center gap-1.5 text-background/60">
            <TerminalIcon className="size-3.5" /> External API
          </p>
          <h3 className="mt-1 text-base font-semibold">Connect the agent</h3>
        </div>
        <div className="readout rounded-full border border-background/20 px-2.5 py-1 text-background/70">
          text only · stateless
        </div>
      </div>

      <div className="space-y-4 p-4">
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
              <p className="min-w-0 flex-1 text-sm font-semibold">Copy this key now — it is shown once.</p>
              <Button variant="secondary" size="sm" onClick={() => void onCopy(token, 'key')}>
                {copied === 'key' ? <CheckIcon /> : <CopyIcon />}
                {copied === 'key' ? 'Copied' : 'Copy key'}
              </Button>
            </div>
            <p className="readout mt-3 overflow-x-auto whitespace-nowrap text-background/80">{token}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-background/15 px-3 py-2.5 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-sm text-background/70">
              Active key ends in <span className="readout text-background">{agent.tokenHint}</span>. The
              full key is hidden.
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
              className="flex items-center gap-1 text-xs text-background/65 hover:text-background focus-visible:underline focus-visible:outline-none"
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
    <section className="rounded-xl border bg-card p-4">
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
        <div
          aria-live="polite"
          className="mb-4 rounded-lg bg-muted/60 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
        >
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
