import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  CloudIcon,
  MailIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  addMcpServer,
  deleteMcpServer,
  listMcpServers,
  refreshMcpServer,
  setMcpServerEnabled,
  type NewMcpServerInput,
} from '@/lib/api'
import { useScope } from '@/hooks/use-workspace'
import { CONNECTORS, connectorEnv, missingFields, type Connector } from '@/lib/connectors'
import type { McpServerRow } from '@/lib/types'
import { cn } from '@/lib/utils'

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

  const enabled = servers.filter((s) => s.enabled && s.status === 'connected')
  const toolTotal = enabled.reduce((n, s) => n + s.toolCount, 0)

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="label text-muted-foreground">MCP servers</h2>
        {enabled.length ? (
          <span className="readout text-[0.625rem] text-muted-foreground">
            {enabled.length} server{enabled.length === 1 ? '' : 's'} · {toolTotal} tools
          </span>
        ) : null}
        {busy ? <Spinner className="ml-auto size-3.5 text-muted-foreground" /> : null}
      </div>

      <button
        type="button"
        onClick={() => {
          setChosen(null)
          setManual(false)
          setError(null)
          setPicking(true)
        }}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2.5',
          'text-xs text-muted-foreground transition-colors',
          'hover:border-foreground/30 hover:text-foreground',
        )}
      >
        <PlusIcon className="size-3.5" />
        Connect an MCP server
      </button>

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

      {servers.length ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {servers.map((s) => (
            <ServerItem
              key={s.id}
              server={s}
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
const CONNECTOR_ICONS = { cloud: CloudIcon, mail: MailIcon } as const

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
function AddServerForm({
  busy,
  error,
  onSubmit,
  onBack,
}: {
  busy: boolean
  error: string | null
  onSubmit: (input: NewMcpServerInput) => Promise<boolean>
  onBack: () => void
}) {
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authHeader, setAuthHeader] = useState('')
  const [command, setCommand] = useState('npx')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')

  const reset = () => {
    setName('')
    setUrl('')
    setAuthHeader('')
    setArgsText('')
    setEnvText('')
  }

  const submit = async () => {
    if (!name.trim()) return
    const input: NewMcpServerInput =
      transport === 'http'
        ? {
            name: name.trim(),
            transport,
            url: url.trim(),
            headers: authHeader.trim() ? { Authorization: authHeader.trim() } : {},
          }
        : {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: splitArgs(argsText),
            env: parseEnv(envText),
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
          Configure manually
        </DialogTitle>
        <DialogDescription>
          For a server that is not in the list. The API validates the command before it runs.
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
                  Optional. Sent as the Authorization header on every request.
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
          {busy ? 'Connecting…' : 'Connect'}
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
  onRefresh,
  onRemove,
}: {
  server: McpServerRow
  onToggle: () => Promise<void>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{server.error ?? 'unreachable'}</TooltipContent>
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
        <span className="readout block truncate text-[0.625rem] text-muted-foreground">
          {detail}
        </span>
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
