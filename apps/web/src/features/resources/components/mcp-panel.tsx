import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  CloudIcon,
  KanbanIcon,
  MailIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { PanelEmpty, PanelHeader } from '@/features/resources/components/panel-kit'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  addMcpServer,
  deleteMcpServer,
  listMcpServers,
  refreshMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  type NewMcpServerInput,
} from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { CONNECTORS, connectorEnv, missingFields, type Connector } from '@/features/resources/lib/connectors'
import type { McpServerRow } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'

/**
 * Connect MCP servers and see what they give the agent.
 *
 * A server that failed to connect is listed alongside the ones that worked,
 * carrying its reason — the same stance the database and document panels take.
 * Disabling is separate from removing: a server that is noisy or slow for one
 * body of work is usually worth keeping, just not right now.
 */
export function McpPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [servers, setServers] = useState<McpServerRow[]>([])
  const [picking, setPicking] = useState(false)
  const [chosen, setChosen] = useState<Connector | null>(null)
  const [manual, setManual] = useState(false)
  const [editing, setEditing] = useState<McpServerRow | null>(null)
  const [diagnosing, setDiagnosing] = useState<McpServerRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = useScope()

  useEffect(() => onCountChange?.(servers.length), [servers.length, onCountChange])

  const refresh = useCallback(async () => {
    try {
      setServers(await listMcpServers(scope))
    } catch {
      // Secondary to the console; a listing failure is not fatal.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * One submit path for both forms.
   *
   * A connector and the manual form differ only in how the payload is
   * assembled — by the time it is sent they are the same shape, and the API
   * validates it identically. Sharing this keeps the error and busy handling
   * from drifting between the two.
   */
  const submit = useCallback(
    async (input: NewMcpServerInput) => {
      setBusy(true)
      setError(null)
      try {
        const out = await addMcpServer(scope, input)
        if (out.error) {
          setError(out.error)
          return false
        }
        await refresh()
        return true
      } catch {
        setError('Could not reach the API')
        return false
      } finally {
        setBusy(false)
      }
    },
    [scope, refresh],
  )

  const closePicker = () => {
    setPicking(false)
    setChosen(null)
    setManual(false)
    setError(null)
  }

  const openPicker = () => {
    setChosen(null)
    setManual(false)
    setError(null)
    setPicking(true)
  }

  const enabled = servers.filter((s) => s.enabled && s.status === 'connected')
  const toolTotal = enabled.reduce((n, s) => n + s.toolCount, 0)

  return (
    <div className="flex flex-col">
      <PanelHeader
        busy={busy}
        summary={
          enabled.length
            ? `${enabled.length} server${enabled.length === 1 ? '' : 's'} · ${toolTotal} tools`
            : null
        }
        action={
          servers.length ? (
            <Button size="sm" onClick={openPicker}>
              <PlusIcon data-icon="inline-start" />
              Connect a server
            </Button>
          ) : null
        }
      />

      {servers.length === 0 ? (
        <PanelEmpty
          icon={PlugIcon}
          title="No MCP servers"
          description="Connect a server and its tools become the agent's — your files, your calendar, your tracker, whatever it speaks for."
          action={
            <Button size="sm" onClick={openPicker}>
              <PlusIcon data-icon="inline-start" />
              Connect a server
            </Button>
          }
        />
      ) : null}

      {/* Separate dialog from the picker: an edit starts from a row, not from
          "Connect an MCP server", and sharing one dialog would mean the picker
          could appear behind a Back press during an edit. */}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
            setError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {editing ? (
            <AddServerForm
              busy={busy}
              error={error}
              editing={editing}
              onBack={() => {
                setEditing(null)
                setError(null)
              }}
              onSubmit={async (input) => {
                setBusy(true)
                setError(null)
                const { error: failed } = await updateMcpServer(scope, editing.id, input)
                setBusy(false)
                if (failed) {
                  setError(failed)
                  return false
                }
                await refresh()
                setEditing(null)
                return true
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!diagnosing}
        onOpenChange={(open) => {
          if (!open) setDiagnosing(null)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {diagnosing ? (
            <ConnectionReport
              server={
                // Re-read from the list so a retry's outcome replaces what is
                // on screen instead of leaving the first failure frozen there.
                servers.find((s) => s.id === diagnosing.id) ?? diagnosing
              }
              busy={busy}
              onRetry={async () => {
                setBusy(true)
                await refreshMcpServer(scope, diagnosing.id)
                await refresh()
                setBusy(false)
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={picking}
        onOpenChange={(open) => {
          if (!open) closePicker()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {manual ? (
            <AddServerForm
              busy={busy}
              error={error}
              onBack={() => {
                setManual(false)
                setError(null)
              }}
              onSubmit={async (input) => {
                const done = await submit(input)
                if (done) closePicker()
                return done
              }}
            />
          ) : chosen ? (
            <ConnectorForm
              connector={chosen}
              busy={busy}
              error={error}
              onBack={() => {
                setChosen(null)
                setError(null)
              }}
              onSubmit={async (input) => {
                const done = await submit(input)
                if (done) closePicker()
                return done
              }}
            />
          ) : (
            <ConnectorPicker
              onChoose={(connector) => {
                setError(null)
                setChosen(connector)
              }}
              onManual={() => {
                setError(null)
                setManual(true)
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* A card holding rows rather than a grid of cards: an MCP row opens to a
          list of every tool the server advertises, and a card that unfolds to a
          hundred lines is not a card. */}
      {servers.length ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {servers.map((s) => (
            <ServerItem
              key={s.id}
              server={s}
              onEdit={() => {
                setError(null)
                setEditing(s)
              }}
              onDiagnose={() => setDiagnosing(s)}
              onToggle={async () => {
                // Optimistic: the round trip is a single UPDATE, and a switch
                // that lags behind the click reads as broken.
                setServers((prev) =>
                  prev.map((x) => (x.id === s.id ? { ...x, enabled: x.enabled ? 0 : 1 } : x)),
                )
                await setMcpServerEnabled(scope, s.id, !s.enabled)
                await refresh()
              }}
              onRefresh={async () => {
                setBusy(true)
                try {
                  await refreshMcpServer(scope, s.id)
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
              onRemove={async () => {
                setServers((prev) => prev.filter((x) => x.id !== s.id)) // optimistic
                await deleteMcpServer(scope, s.id)
                await refresh()
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Catalog icons, resolved here so `lib/connectors.ts` stays free of JSX. */
const CONNECTOR_ICONS = { cloud: CloudIcon, mail: MailIcon, kanban: KanbanIcon } as const

/** The field styling every input in this panel shares. */
const FIELD_CLASS =
  'w-full rounded-md border bg-transparent px-2.5 py-2 text-xs outline-none transition-colors focus-visible:border-foreground/40'

/**
 * The dialog body, on the same rhythm as DialogHeader.
 *
 * DialogContent is `gap-0` and the header brings its own `px-5 py-4`, so a body
 * that does not repeat that padding sits flush against the border.
 */
const BODY_CLASS = 'px-5 py-4'

/** Return to the picker. Shared so both detail screens leave the same way. */
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back to connectors"
      className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
    >
      <ChevronLeftIcon className="size-4" />
    </button>
  )
}

/**
 * Pick a known server, or fall through to the manual form.
 *
 * Each card shows the command it will actually spawn. That is the one thing a
 * template hides, and this console's whole job is running processes on your
 * behalf — so what is about to run belongs on the face of the card, in the same
 * mono readout used for tool names and trace lines elsewhere.
 */
function ConnectorPicker({
  onChoose,
  onManual,
}: {
  onChoose: (connector: Connector) => void
  onManual: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect an MCP server</DialogTitle>
        <DialogDescription>
          Pick a known one and fill in only its credentials, or configure it yourself.
        </DialogDescription>
      </DialogHeader>

      <div className={BODY_CLASS}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {CONNECTORS.map((connector) => {
            const Icon = CONNECTOR_ICONS[connector.icon]
            return (
              <button
                key={connector.id}
                type="button"
                onClick={() => onChoose(connector)}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left',
                  'transition-colors outline-none',
                  'hover:border-foreground/30 hover:bg-accent',
                  'focus-visible:border-foreground/40 focus-visible:bg-accent',
                )}
              >
                <Icon className="mb-1 size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm leading-snug">{connector.name}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {connector.summary}
                </span>
                {/* mt-auto so the command sits on the baseline of every card,
                    whatever length the summary above it runs to. */}
                <span className="readout mt-auto w-full truncate pt-2.5 text-[0.625rem] text-muted-foreground/70">
                  {[connector.command, ...connector.args].join(' ')}
                </span>
              </button>
            )
          })}
        </div>

        {/* An escape hatch, not a third connector — full width, below the grid. */}
        <button
          type="button"
          onClick={onManual}
          className={cn(
            'mt-2.5 flex w-full items-center gap-2.5 rounded-lg border border-dashed px-4 py-3 text-left',
            'transition-colors outline-none',
            'hover:border-foreground/30 hover:bg-accent',
            'focus-visible:border-foreground/40 focus-visible:bg-accent',
          )}
        >
          <SlidersHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs leading-snug">Something else</span>
            <span className="block text-[0.625rem] leading-relaxed text-muted-foreground">
              Enter the command, arguments and environment yourself
            </span>
          </span>
        </button>
      </div>
    </>
  )
}

/**
 * A connector's credentials, as named fields.
 *
 * The launcher, package and flags are the template's and are not shown as
 * editable text — they are the half that is identical on every install, and
 * every character of it typed by hand is a chance to get it wrong. What is left
 * is what actually differs between two people connecting the same server.
 */
function ConnectorForm({
  connector,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  connector: Connector
  busy: boolean
  error: string | null
  onSubmit: (input: NewMcpServerInput) => Promise<boolean>
  onBack: () => void
}) {
  const [name, setName] = useState(connector.id)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(connector.fields.map((f) => [f.key, f.default ?? ''])),
  )
  const [touched, setTouched] = useState(false)

  const missing = missingFields(connector, values)

  const submit = async () => {
    setTouched(true)
    if (!name.trim() || missing.length) return
    await onSubmit({
      name: name.trim(),
      transport: 'stdio',
      command: connector.command,
      args: connector.args,
      env: connectorEnv(connector, values),
    })
    // Same stance as the manual form: a credential does not stay in a live
    // input after it has been sent, whether or not the server accepted it.
    setValues((prev) =>
      Object.fromEntries(
        connector.fields.map((f) => [f.key, f.type === 'password' ? '' : (prev[f.key] ?? '')]),
      ),
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <BackButton onClick={onBack} />
          {connector.name}
        </DialogTitle>
        <DialogDescription>{connector.summary}</DialogDescription>
      </DialogHeader>

      <div className={cn(BODY_CLASS, 'flex flex-col gap-4')}>
        {connector.note ? (
          <p className="rounded-lg border border-dashed px-3 py-2.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
            {connector.note}
          </p>
        ) : null}

        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={FIELD_CLASS}
              placeholder={connector.id}
            />
          </label>

          {connector.fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1.5">
              {/* The variable being set is shown, not hidden behind the label —
                  same reason the picker shows the command: nothing this form
                  writes should be a surprise. */}
              <span className="flex items-baseline justify-between gap-3">
                <span className="label text-muted-foreground">{field.label}</span>
                <span className="readout truncate text-[0.625rem] text-muted-foreground/60">
                  {field.key}
                </span>
              </span>
              <input
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                type={field.type === 'password' ? 'password' : 'text'}
                placeholder={field.placeholder}
                className={FIELD_CLASS}
              />
              {field.help ? (
                <span className="text-[0.625rem] leading-relaxed text-muted-foreground">
                  {field.help}
                </span>
              ) : null}
            </label>
          ))}
        </div>

        {/* The API's own error wins: it is the one that knows what failed. */}
        {error ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{error}</p>
        ) : touched && missing.length ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            Still needed: {missing.map((f) => f.label).join(', ')}
          </p>
        ) : null}
      </div>

      {/* Bordered footer, mirroring the header band. */}
      <div className="flex gap-2 border-t px-5 py-3.5">
        <Button type="submit" size="sm" disabled={busy} className="flex-1">
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  )
}

/** Launchers the API will spawn. Kept in step with services/mcp/allowlist.ts. */
const ALLOWED_COMMANDS = 'npx, uvx, node, python, python3, bun, deno'

/**
 * Two transports, one form.
 *
 * The transport picker swaps the fields rather than showing both: a stdio
 * server has no URL and an HTTP server has no command, so showing all four at
 * once would mean two of them are always wrong to fill in.
 */
/**
 * The manual form, used both to add a server and to edit one.
 *
 * `editing` is the only difference, and it changes one rule that matters: a
 * blank credential field means "leave the stored one alone" rather than "no
 * credential". The API never sends a secret back, so the form has nothing to
 * prefill and cannot tell an untouched field from an emptied one — the two are
 * distinguished by omitting the key entirely, which is what `undefined` does
 * once JSON.stringify drops it.
 */
function AddServerForm({
  busy,
  error,
  editing,
  onSubmit,
  onBack,
}: {
  busy: boolean
  error: string | null
  /** The server being edited, or null when adding a new one. */
  editing?: McpServerRow | null
  onSubmit: (input: NewMcpServerInput) => Promise<boolean>
  onBack: () => void
}) {
  const [transport, setTransport] = useState<'http' | 'stdio'>(editing?.transport ?? 'http')
  const [name, setName] = useState(editing?.name ?? '')
  const [url, setUrl] = useState(editing?.url ?? '')
  const [authHeader, setAuthHeader] = useState('')
  const [command, setCommand] = useState(editing?.command ?? 'npx')
  const [argsText, setArgsText] = useState((editing?.args ?? []).join(' '))
  const [envText, setEnvText] = useState('')

  const storedKeys = (transport === 'http' ? editing?.headerKeys : editing?.envKeys) ?? []

  const reset = () => {
    setName('')
    setUrl('')
    setAuthHeader('')
    setArgsText('')
    setEnvText('')
  }

  const submit = async () => {
    if (!name.trim()) return
    // Adding: a blank field is an empty credential. Editing: it is silence, so
    // the key is omitted and the API keeps what is stored.
    const keepSecret = !!editing
    const input: NewMcpServerInput =
      transport === 'http'
        ? {
            name: name.trim(),
            transport,
            url: url.trim(),
            headers: authHeader.trim()
              ? { Authorization: authHeader.trim() }
              : keepSecret
                ? undefined
                : {},
          }
        : {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: splitArgs(argsText),
            env: envText.trim() ? parseEnv(envText) : keepSecret ? undefined : {},
          }
    const done = await onSubmit(input)
    // Credentials must not sit in a live input for as long as the panel stays
    // mounted, so they are dropped either way; the rest survives a rejection so
    // the user can correct one field rather than retyping the form.
    setAuthHeader('')
    setEnvText('')
    if (done) reset()
  }

  const back = () => {
    reset()
    onBack()
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <BackButton onClick={back} />
          {editing ? `Edit ${editing.name}` : 'Configure manually'}
        </DialogTitle>
        <DialogDescription>
          {editing
            ? 'Changing the connection clears the cached tool list and reconnects.'
            : 'For a server that is not in the list. The API validates the command before it runs.'}
        </DialogDescription>
      </DialogHeader>

      <div className={cn(BODY_CLASS, 'flex flex-col gap-4')}>
        <div className="flex gap-1 rounded-lg border p-1">
          {(['http', 'stdio'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTransport(t)}
              aria-pressed={transport === t}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-xs transition-colors outline-none',
                transport === t
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground focus-visible:text-foreground',
              )}
            >
              {t === 'http' ? 'Remote (HTTP)' : 'Local (stdio)'}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="github"
              className={FIELD_CLASS}
            />
          </label>

          {transport === 'http' ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="label text-muted-foreground">URL</span>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  className={FIELD_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="label text-muted-foreground">Authorization header</span>
                <input
                  type="password"
                  value={authHeader}
                  onChange={(e) => setAuthHeader(e.target.value)}
                  placeholder="Bearer …"
                  className={FIELD_CLASS}
                />
                <span className="text-[0.625rem] leading-relaxed text-muted-foreground">
                  {editing && storedKeys.length
                    ? `Already stored: ${storedKeys.join(', ')}. Leave blank to keep it.`
                    : 'Optional. Sent as the Authorization header on every request.'}
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="label text-muted-foreground">Command</span>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className={FIELD_CLASS}
                />
                <span className="readout text-[0.625rem] leading-relaxed text-muted-foreground/70">
                  {ALLOWED_COMMANDS}
                </span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="label text-muted-foreground">Arguments</span>
                <input
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /srv/data"
                  className={FIELD_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="label text-muted-foreground">Environment</span>
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={'API_KEY=…\nONE_PER_LINE=…'}
                  rows={3}
                  className={cn(FIELD_CLASS, 'readout resize-y')}
                />
                <span className="text-[0.625rem] leading-relaxed text-muted-foreground">
                  One KEY=value per line. Values are taken verbatim — do not quote them.
                  {editing && storedKeys.length
                    ? ` Already stored: ${storedKeys.join(', ')}. Leave blank to keep them; anything you type replaces the set.`
                    : ''}
                </span>
              </label>
            </>
          )}
        </div>

        {error ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{error}</p>
        ) : null}
      </div>

      <div className="flex gap-2 border-t px-5 py-3.5">
        <Button type="submit" size="sm" disabled={busy} className="flex-1">
          {busy ? 'Connecting…' : editing ? 'Save and reconnect' : 'Connect'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={back}>
          Back
        </Button>
      </div>
    </form>
  )
}

/**
 * Split an argument line on whitespace, honouring quotes.
 *
 * A filesystem server pointed at "/srv/my data" is common enough that naive
 * splitting would break the first real use.
 */
function splitArgs(text: string): string[] {
  const matches = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map((a) => a.replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** KEY=value per line. Anything without an `=` is skipped rather than guessed at. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key) out[key] = line.slice(at + 1).trim()
  }
  return out
}

function ServerItem({
  server,
  onToggle,
  onEdit,
  onDiagnose,
  onRefresh,
  onRemove,
}: {
  server: McpServerRow
  onToggle: () => Promise<void>
  onEdit: () => void
  onDiagnose: () => void
  onRefresh: () => Promise<void>
  onRemove: () => Promise<void>
}) {
  const failed = server.status !== 'connected'
  const off = !server.enabled
  const resourceCount = server.capabilities.filter((c) => c.kind === 'resource').length
  const promptCount = server.capabilities.filter((c) => c.kind === 'prompt').length

  const detail = failed
    ? 'could not connect'
    : [
        `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`,
        resourceCount ? `${resourceCount} resource${resourceCount === 1 ? '' : 's'}` : '',
        promptCount ? `${promptCount} prompt${promptCount === 1 ? '' : 's'}` : '',
        server.transport === 'stdio' ? server.command : hostOf(server.url),
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      {failed ? (
        // A button, not a tooltip. The reason a connection failed is usually a
        // traceback: it has to be readable at length and selectable to paste
        // somewhere, and a hover card that truncates at 16rem is neither.
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDiagnose}
              aria-label={`Why ${server.name} failed`}
              className="shrink-0 rounded-sm outline-none focus-visible:ring-[1.5px] focus-visible:ring-foreground/40"
            >
              <AlertTriangleIcon className="size-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>See why it failed</TooltipContent>
        </Tooltip>
      ) : server.transport === 'stdio' ? (
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <PlugIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}

      <span className="min-w-0 flex-1">
        <span
          className={cn('block truncate text-xs', (failed || off) && 'text-muted-foreground')}
        >
          {server.name}
          {off ? <span className="ml-1.5 opacity-60">(off)</span> : null}
        </span>
        {failed ? (
          <button
            type="button"
            onClick={onDiagnose}
            className={cn(
              'readout block max-w-full truncate text-left text-[0.625rem] text-muted-foreground',
              'underline decoration-dotted underline-offset-2 outline-none',
              'hover:text-foreground focus-visible:text-foreground',
            )}
          >
            could not connect — see details
          </button>
        ) : (
          <span className="readout block truncate text-[0.625rem] text-muted-foreground">
            {detail}
          </span>
        )}
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onToggle()}
        aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <PlugIcon className={cn(off && 'opacity-40')} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onEdit}
        aria-label={`Edit ${server.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <PencilIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onRefresh()}
        aria-label={`Refresh ${server.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <RefreshCwIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void onRemove()}
        aria-label={`Remove ${server.name}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2Icon />
      </Button>
    </li>
  )
}

/** The host is what identifies a remote server at a glance; the path is noise. */
function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Why a server would not connect.
 *
 * Three things, in the order you need them: what was attempted, what came back,
 * and what the process said before it died. The third is the one that was
 * missing — nothing drained the stdio pipe, so a launcher that failed during
 * startup reported only the timeout that followed, never the cause.
 *
 * Everything is selectable and the output keeps its own line breaks, because
 * the realistic next step is pasting it into a search or an issue.
 */
function ConnectionReport({
  server,
  busy,
  onRetry,
}: {
  server: McpServerRow
  busy: boolean
  onRetry: () => Promise<void>
}) {
  const attempted =
    server.transport === 'stdio'
      ? [server.command, ...server.args].filter(Boolean).join(' ')
      : (server.url ?? '')
  const recovered = server.status === 'connected'

  return (
    <>
      <DialogHeader>
        <DialogTitle>{server.name}</DialogTitle>
        <DialogDescription>
          {recovered
            ? 'Connected. This server is working now.'
            : 'This server did not connect. Everything below is selectable.'}
        </DialogDescription>
      </DialogHeader>

      <div className={cn(BODY_CLASS, 'flex flex-col gap-4')}>
        <Field label={server.transport === 'stdio' ? 'Command' : 'URL'}>{attempted}</Field>

        {server.error ? <Field label="Error">{server.error}</Field> : null}

        {server.errorDetail ? (
          <div className="flex flex-col gap-1.5">
            <span className="label text-muted-foreground">
              {server.transport === 'stdio' ? 'Server output (stderr)' : 'Response'}
            </span>
            <pre className="readout max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-[0.6875rem] leading-relaxed whitespace-pre-wrap">
              {server.errorDetail}
            </pre>
          </div>
        ) : !recovered ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            The server produced no output before it failed. For a stdio server that usually means
            the launcher itself never started — check that the command is spelled correctly and
            that the package exists.
          </p>
        ) : null}

        <p className="text-[0.625rem] leading-relaxed text-muted-foreground">
          {server.lastProbedAt
            ? `Last checked ${new Date(server.lastProbedAt).toLocaleString()}.`
            : 'Never connected successfully.'}
        </p>
      </div>

      <div className="flex gap-2 border-t px-5 py-3.5">
        <Button type="button" size="sm" disabled={busy} onClick={() => void onRetry()}>
          {busy ? 'Reconnecting…' : 'Try again'}
        </Button>
      </div>
    </>
  )
}

/** A labelled, selectable value. Mono, because all of these are machine strings. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label text-muted-foreground">{label}</span>
      <p className="readout rounded-md border bg-muted/40 p-3 text-[0.6875rem] leading-relaxed break-all">
        {children}
      </p>
    </div>
  )
}
