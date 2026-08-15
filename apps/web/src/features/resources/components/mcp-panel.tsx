import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangleIcon,
  CalendarIcon,
  ChevronLeftIcon,
  CloudIcon,
  DownloadIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Spinner } from '@/shared/ui/spinner'
import {
  addMcpServer,
  deleteConnector,
  deleteMcpServer,
  googleAuthUrl,
  importMcpServer,
  listConnectors,
  listImportableMcpServers,
  listMcpServers,
  refreshMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  type ConnectorKind,
  type ConnectorRow,
  type ImportCatalog,
  type ImportableServer,
  type NewMcpServerInput,
} from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import {
  CONNECTORS,
  connectorEnv,
  matchConnector,
  missingFields,
  type Connector,
} from '@/features/resources/lib/connectors'
import { ServiceMark, serviceLabel } from '@/features/resources/components/service-mark'
import type { McpServerRow } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'

/**
 * Google connectors, presented in the same picker as the MCP services.
 *
 * To the reader these are the same choice — which of my services can the agent
 * reach — so they sit beside Nextcloud and Plane rather than on a page of their
 * own. What differs is entirely under the hood: choosing one opens Google's
 * OAuth consent instead of a credentials form, and the result is a `connectors`
 * row (live first-party tools), not an `mcp_servers` row.
 */
const GOOGLE_SERVICES: {
  kind: ConnectorKind
  name: string
  summary: string
  icon: typeof CalendarIcon
  tint: string
}[] = [
  {
    kind: 'gcal',
    name: 'Google Calendar',
    summary: 'Read your schedule and create, move or cancel events',
    icon: CalendarIcon,
    tint: '66 133 244',
  },
  {
    kind: 'gdrive',
    name: 'Google Drive',
    summary: 'Index your Drive files into the workspace so the agent can search them',
    icon: CloudIcon,
    tint: '30 142 62',
  },
]

/** The tinted service badge, matching ServiceMark's shape for the Google cards. */
function GoogleMark({
  icon: Icon,
  tint,
  className,
}: {
  icon: typeof CalendarIcon
  tint: string
  className?: string
}) {
  return (
    <span
      className={cn('grid size-8 place-items-center rounded-md', className)}
      style={{ backgroundColor: `rgb(${tint} / 0.14)`, color: `rgb(${tint})` }}
    >
      <Icon className="size-4" />
    </span>
  )
}

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
  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [googleBlocked, setGoogleBlocked] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [chosen, setChosen] = useState<Connector | null>(null)
  const [manual, setManual] = useState(false)
  const [importing, setImporting] = useState(false)
  const [catalog, setCatalog] = useState<ImportCatalog | null>(null)
  const [editing, setEditing] = useState<McpServerRow | null>(null)
  const [viewing, setViewing] = useState<McpServerRow | null>(null)
  const [removing, setRemoving] = useState<McpServerRow | null>(null)
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
    try {
      const { connectors: rows, available } = await listConnectors(scope)
      setConnectors(rows)
      // Google is one OAuth client for both connectors, so it is configured or
      // blocked as a whole — surface the reason on the picker cards.
      setGoogleBlocked(available.find((a) => a.kind === 'gcal' || a.kind === 'gdrive')?.reason ?? null)
    } catch {
      // Same stance as the server list above.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Google consent happens in a second tab that cannot talk back to this one,
  // so re-read when the window regains focus — the moment the user returns.
  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
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
    setImporting(false)
    setError(null)
  }

  /**
   * Start a Google OAuth grant in a second tab.
   *
   * Google refuses to render consent in an iframe, and a same-tab navigation
   * would lose whatever is in flight here — so it opens a tab and the focus
   * listener above re-reads the connector list when the user comes back. The
   * picker closes because the next thing to look at is in the other tab.
   */
  const connectGoogle = async (kind: ConnectorKind) => {
    setError(null)
    try {
      const url = await googleAuthUrl(scope, kind)
      window.open(url, '_blank', 'noopener')
      closePicker()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const disconnectGoogle = async (row: ConnectorRow) => {
    const isDrive = row.kind === 'gdrive'
    const consequence = isDrive
      ? ` Its ${row.documentCount} indexed document(s) will be removed.`
      : ' The agent will lose access to it.'
    if (!window.confirm(`Disconnect ${row.accountEmail ?? 'this account'}?${consequence}`)) return
    setConnectors((prev) => prev.filter((c) => c.id !== row.id)) // optimistic
    await deleteConnector(scope, row.id)
    await refresh()
  }

  const openPicker = () => {
    setChosen(null)
    setManual(false)
    setImporting(false)
    setError(null)
    setPicking(true)
    // Read on open rather than on mount: a user with one workspace never has
    // anything to import, and this is one request per workspace they own.
    void listImportableMcpServers(scope)
      .then(setCatalog)
      .catch(() => setCatalog({ sources: [], alreadyHere: 0 }))
  }


  const enabled = servers.filter((s) => s.enabled && s.status === 'connected')
  const toolTotal = enabled.reduce((n, s) => n + s.toolCount, 0)
  const connectedTotal = enabled.length + connectors.length
  const hasAny = servers.length > 0 || connectors.length > 0

  return (
    <div className="flex flex-col">
      <PanelHeader
        busy={busy}
        summary={
          connectedTotal
            ? `${connectedTotal} connected${toolTotal ? ` · ${toolTotal} tools` : ''}`
            : null
        }
        action={
          hasAny ? (
            <Button size="sm" onClick={openPicker}>
              <PlusIcon data-icon="inline-start" />
              Connect a service
            </Button>
          ) : null
        }
      />

      {!hasAny ? (
        <PanelEmpty
          icon={PlugIcon}
          title="No connectors yet"
          description="Connect a service and its tools become the agent's — your files, your calendar, your tracker, whatever it speaks for."
          action={
            <Button size="sm" onClick={openPicker}>
              <PlusIcon data-icon="inline-start" />
              Connect a service
            </Button>
          }
        />
      ) : null}

      {/* Separate dialog from the picker: an edit starts from a row, not from
          "Connect a service", and sharing one dialog would mean the picker
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
        open={!!viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {viewing ? (
            <ServerDetail
              server={
                // Re-read from the list so a retry's outcome replaces what is
                // on screen instead of leaving the first failure frozen there.
                servers.find((s) => s.id === viewing.id) ?? viewing
              }
              busy={busy}
              onEdit={() => {
                const row = servers.find((s) => s.id === viewing.id) ?? viewing
                setViewing(null)
                setError(null)
                setEditing(row)
              }}
              onRetry={async () => {
                setBusy(true)
                try {
                  await refreshMcpServer(scope, viewing.id)
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
              onRemove={() => {
                const row = servers.find((s) => s.id === viewing.id) ?? viewing
                setViewing(null)
                setRemoving(row)
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Removing is the one action here with no undo — the credentials go with
          the row, so putting it back means retyping a password. It used to be a
          single unguarded click on a hover control sitting next to three
          harmless ones. */}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          {removing ? (
            <ConfirmRemove
              server={removing}
              onCancel={() => setRemoving(null)}
              onConfirm={async () => {
                const id = removing.id
                setRemoving(null)
                setServers((prev) => prev.filter((x) => x.id !== id)) // optimistic
                await deleteMcpServer(scope, id)
                await refresh()
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
          {importing ? (
            <ImportPicker
              catalog={catalog}
              busy={busy}
              error={error}
              onBack={() => {
                setImporting(false)
                setError(null)
              }}
              onImport={async (workspaceId, serverId) => {
                setBusy(true)
                setError(null)
                const { error: failed } = await importMcpServer(scope, workspaceId, serverId)
                setBusy(false)
                if (failed) {
                  setError(failed)
                  return
                }
                await refresh()
                closePicker()
              }}
            />
          ) : manual ? (
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
              catalog={catalog}
              googleBlocked={googleBlocked}
              onConnectGoogle={connectGoogle}
              onChoose={(connector) => {
                setError(null)
                setChosen(connector)
              }}
              onManual={() => {
                setError(null)
                setManual(true)
              }}
              onImport={() => {
                setError(null)
                setImporting(true)
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {hasAny ? (
        <PanelGrid>
          {servers.map((s) => (
            <ServerItem
              key={s.id}
              server={s}
              onEdit={() => {
                setError(null)
                setEditing(s)
              }}
              onOpen={() => setViewing(s)}
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
              onRemove={() => setRemoving(s)}
            />
          ))}
          {connectors.map((row) => (
            <GoogleConnectorItem
              key={row.id}
              connector={row}
              onDisconnect={() => void disconnectGoogle(row)}
            />
          ))}
        </PanelGrid>
      ) : null}
    </div>
  )
}

/**
 * A connected Google account, as a card alongside the MCP servers.
 *
 * No enable/refresh controls: unlike an MCP server there is no process to probe
 * or pause — the tools are live whenever the grant is. Disconnect is the only
 * action, and it revokes the app's access on removal.
 */
function GoogleConnectorItem({
  connector,
  onDisconnect,
}: {
  connector: ConnectorRow
  onDisconnect: () => void
}) {
  const svc = GOOGLE_SERVICES.find((g) => g.kind === connector.kind)
  const label = svc?.name ?? 'Google'
  const detail =
    connector.kind === 'gdrive'
      ? `${connector.documentCount} doc${connector.documentCount === 1 ? '' : 's'} indexed`
      : 'agent tools'
  return (
    <ItemCard
      leading={svc ? <GoogleMark icon={svc.icon} tint={svc.tint} className="mt-0.5" /> : undefined}
      title={connector.accountEmail ?? label}
      meta={
        <span className="flex flex-wrap gap-x-2">
          <span>{label}</span>
          <span>{detail}</span>
          {connector.error ? <span className="text-destructive">{connector.error}</span> : null}
        </span>
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDisconnect}
          aria-label="Disconnect"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon />
        </Button>
      }
    />
  )
}

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
  catalog,
  googleBlocked,
  onConnectGoogle,
  onChoose,
  onManual,
  onImport,
}: {
  /** What could be imported from elsewhere; null while it is still loading. */
  catalog: ImportCatalog | null
  /** Why the Google cards are disabled, or null when they can be used. */
  googleBlocked: string | null
  onConnectGoogle: (kind: ConnectorKind) => void
  onChoose: (connector: Connector) => void
  onManual: () => void
  onImport: () => void
}) {
  const importable = catalog && catalog.sources.reduce((n, s) => n + s.servers.length, 0)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect a service</DialogTitle>
        <DialogDescription>
          Pick a known one and fill in only its credentials, or configure it yourself.
        </DialogDescription>
      </DialogHeader>

      <div className={BODY_CLASS}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {/* Google connectors first: they are the first-party ones, and OAuth
              is less to fill in than any credentials form below them. */}
          {GOOGLE_SERVICES.map((svc) => (
            <button
              key={svc.kind}
              type="button"
              disabled={!!googleBlocked}
              title={googleBlocked ?? undefined}
              onClick={() => onConnectGoogle(svc.kind)}
              className={cn(
                'flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left',
                'transition-colors outline-none',
                'hover:border-foreground/30 hover:bg-accent',
                'focus-visible:border-foreground/40 focus-visible:bg-accent',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent',
              )}
            >
              <GoogleMark icon={svc.icon} tint={svc.tint} className="mb-1.5" />
              <span className="text-sm leading-snug">{svc.name}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{svc.summary}</span>
              <span className="readout mt-auto w-full truncate pt-2.5 text-[0.625rem] text-muted-foreground/70">
                {googleBlocked ? 'not configured' : 'Sign in with Google'}
              </span>
            </button>
          ))}
          {CONNECTORS.map((connector) => (
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
              <ServiceMark connector={connector} transport="stdio" size="sm" className="mb-1.5" />
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
          ))}
        </div>

        {/* Escape hatches, not more connectors — full width, below the grid.
            Importing comes first: when it applies it is strictly less work than
            either of the paths above it, because the credentials already
            exist.

            Shown even when there is nothing to import. Hiding it made the
            feature unfindable — a user with one empty second workspace saw no
            row, no explanation, and no way to learn the option exists. The
            screen behind it already says what an empty result means, and it is
            a better place to say it than a gap. */}
        <PickerRow
          icon={DownloadIcon}
          title="Import from another workspace"
          detail={
            importable === null
              ? 'Reuse a service you have already set up, credentials included'
              : importable
                ? `${importable} service${importable === 1 ? '' : 's'} you have already set up, credentials included`
                : catalog?.alreadyHere
                  ? 'You are already connected to everything you have elsewhere'
                  : 'Nothing set up elsewhere yet'
          }
          onClick={onImport}
          className="mt-2.5"
        />

        <PickerRow
          icon={SlidersHorizontalIcon}
          title="Something else"
          detail="Enter the command, arguments and environment yourself"
          onClick={onManual}
          className="mt-2.5"
        />
      </div>
    </>
  )
}

/** A full-width row under the connector grid. Same shape for every escape hatch. */
function PickerRow({
  icon: Icon,
  title,
  detail,
  onClick,
  className,
}: {
  icon: typeof SlidersHorizontalIcon
  title: string
  detail: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg border border-dashed px-4 py-3 text-left',
        'transition-colors outline-none',
        'hover:border-foreground/30 hover:bg-accent',
        'focus-visible:border-foreground/40 focus-visible:bg-accent',
        className,
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-xs leading-snug">{title}</span>
        <span className="block text-[0.625rem] leading-relaxed text-muted-foreground">
          {detail}
        </span>
      </span>
    </button>
  )
}

/**
 * Everything this user has connected elsewhere, grouped by workspace.
 *
 * Each row says what will actually arrive — the service, its tool count, and
 * the credential *names* that come with it. Naming them is the point: an import
 * copies a password without ever showing it, and a list that said only
 * "Nextcloud" would be asking for consent to something unstated.
 */
function ImportPicker({
  catalog,
  busy,
  error,
  onImport,
  onBack,
}: {
  /** Null while the list is still arriving. */
  catalog: ImportCatalog | null
  busy: boolean
  error: string | null
  onImport: (workspaceId: string, serverId: string) => Promise<void>
  onBack: () => void
}) {
  const [pending, setPending] = useState<string | null>(null)
  const sources = catalog?.sources ?? null

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <BackButton onClick={onBack} />
          Import from another workspace
        </DialogTitle>
        <DialogDescription>
          A copy, with its credentials. Editing or removing it here leaves the original alone.
        </DialogDescription>
      </DialogHeader>

      <div className={cn(BODY_CLASS, 'flex max-h-[26rem] flex-col gap-5 overflow-y-auto')}>
        {sources === null ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Looking through your other workspaces…
          </div>
        ) : sources.length === 0 ? (
          <p className="py-6 text-xs leading-relaxed text-muted-foreground">
            {catalog?.alreadyHere
              ? 'Everything you have set up elsewhere is already connected here.'
              : 'Your other workspaces have no services connected yet. Connect one there and it will show up here.'}
          </p>
        ) : (
          sources.map((source) => (
            <div key={source.workspaceId} className="flex flex-col gap-2">
              <span className="label text-muted-foreground">{source.workspaceName}</span>
              {source.servers.map((server) => (
                <ImportRow
                  key={server.id}
                  server={server}
                  busy={busy && pending === server.id}
                  disabled={busy}
                  onImport={async () => {
                    setPending(server.id)
                    await onImport(source.workspaceId, server.id)
                    setPending(null)
                  }}
                />
              ))}
            </div>
          ))
        )}

        {error ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{error}</p>
        ) : null}
      </div>
    </>
  )
}

function ImportRow({
  server,
  busy,
  disabled,
  onImport,
}: {
  server: ImportableServer
  busy: boolean
  disabled: boolean
  onImport: () => Promise<void>
}) {
  const connector = matchConnector(server)
  const credentials = [...server.headerKeys, ...server.envKeys]

  return (
    <div className="flex items-start gap-2.5 rounded-lg border p-3">
      <ServiceMark connector={connector} transport={server.transport} size="sm" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs leading-snug">{server.name}</span>
        <span className="readout truncate text-[0.625rem] text-muted-foreground">
          {[
            serviceLabel(connector, server.transport),
            server.status === 'connected'
              ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
              : 'was not connecting',
          ].join(' · ')}
        </span>
        {/* Wraps rather than truncates: the list of keys is the consent, and
            "NEXTCLOUD_US…" hides the half saying a password is not the only
            thing travelling. */}
        {credentials.length ? (
          <span className="readout text-[0.625rem] leading-relaxed break-all text-muted-foreground/70">
            brings {credentials.join(', ')}
          </span>
        ) : null}
        {server.nameTaken ? (
          <span className="text-[0.625rem] leading-relaxed text-muted-foreground">
            You already have a “{server.name}” here — this copy gets a numbered name.
          </span>
        ) : null}
      </div>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => void onImport()}
        className="shrink-0"
      >
        {busy ? <Spinner className="size-3.5" /> : 'Import'}
      </Button>
    </div>
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
  onOpen,
  onRefresh,
  onRemove,
}: {
  server: McpServerRow
  onToggle: () => Promise<void>
  onEdit: () => void
  onOpen: () => void
  onRefresh: () => Promise<void>
  onRemove: () => void
}) {
  const failed = server.status !== 'connected'
  const off = !server.enabled
  const connector = matchConnector(server)
  const resourceCount = server.capabilities.filter((c) => c.kind === 'resource').length
  const promptCount = server.capabilities.filter((c) => c.kind === 'prompt').length

  // The service comes first, because that is the question the list is being
  // asked: which of these is the Nextcloud one. Counts and the launcher follow.
  const detail = [
    serviceLabel(connector, server.transport),
    failed ? 'could not connect' : `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`,
    !failed && resourceCount ? `${resourceCount} resource${resourceCount === 1 ? '' : 's'}` : '',
    !failed && promptCount ? `${promptCount} prompt${promptCount === 1 ? '' : 's'}` : '',
    server.transport === 'stdio' ? server.command : hostOf(server.url),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <ItemCard
      onSelect={onOpen}
      label={`Open ${server.name}`}
      leading={
        <span className="relative">
          <ServiceMark
            connector={connector}
            transport={server.transport}
            className={cn(off && 'opacity-50')}
          />
          {failed ? (
            // Sits on the mark rather than replacing it: a Nextcloud server
            // that will not connect is still the Nextcloud one, and losing the
            // brand is losing the thing you were scanning for.
            <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-card">
              <AlertTriangleIcon className="size-3 text-destructive" />
            </span>
          ) : null}
        </span>
      }
      title={
        <span className={cn((failed || off) && 'text-muted-foreground')}>
          {server.name}
          {off ? <span className="ml-1.5 opacity-60">(off)</span> : null}
        </span>
      }
      meta={<span className="block truncate">{detail}</span>}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void onToggle()}
            aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`}
            className="text-muted-foreground"
          >
            <PlugIcon className={cn(off && 'opacity-40')} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onEdit}
            aria-label={`Edit ${server.name}`}
            className="text-muted-foreground"
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void onRefresh()}
            aria-label={`Reconnect ${server.name}`}
            className="text-muted-foreground"
          >
            <RefreshCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label={`Remove ${server.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon />
          </Button>
        </>
      }
    />
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
 * Everything a connected server is, read-only, with one way out to editing.
 *
 * This replaced a dialog that only opened when a connection had failed, and
 * only carried the traceback. That was the right content for the wrong trigger:
 * "what is this thing actually pointed at, and which credentials does it hold"
 * is a question people have about servers that work, and the panel had no
 * answer that did not involve opening the edit form and risking a change.
 *
 * So: nothing here is an input. Everything is selectable, and the output keeps
 * its own line breaks, because the realistic next step for a failure is pasting
 * it into a search or an issue.
 */
function ServerDetail({
  server,
  busy,
  onEdit,
  onRetry,
  onRemove,
}: {
  server: McpServerRow
  busy: boolean
  onEdit: () => void
  onRetry: () => Promise<void>
  onRemove: () => void
}) {
  const connector = matchConnector(server)
  const connected = server.status === 'connected'
  const attempted =
    server.transport === 'stdio'
      ? [server.command, ...server.args].filter(Boolean).join(' ')
      : (server.url ?? '')
  const credentials = [...(server.headerKeys ?? []), ...(server.envKeys ?? [])]
  const tools = server.capabilities.filter((c) => c.kind === 'tool')

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <ServiceMark connector={connector} transport={server.transport} size="sm" />
          {server.name}
        </DialogTitle>
        <DialogDescription>
          {serviceLabel(connector, server.transport)}
          {' · '}
          {connected
            ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
            : 'not connecting'}
          {server.enabled ? '' : ' · off'}
        </DialogDescription>
      </DialogHeader>

      <div className={cn(BODY_CLASS, 'flex max-h-[26rem] flex-col gap-4 overflow-y-auto')}>
        <Field label={server.transport === 'stdio' ? 'Command' : 'URL'}>{attempted}</Field>

        {/* Names, never values. Showing which keys are set is what makes the
            difference between "this is configured" and "this is empty" legible
            without opening a form that could change it. */}
        <div className="flex flex-col gap-1.5">
          <span className="label text-muted-foreground">
            {server.transport === 'stdio' ? 'Environment' : 'Headers'}
          </span>
          {credentials.length ? (
            <p className="readout rounded-md border bg-muted/40 p-3 text-[0.6875rem] leading-relaxed break-all">
              {credentials.map((key) => `${key}=••••••`).join('\n')}
            </p>
          ) : (
            <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
              Nothing stored. This server runs with no credentials of its own.
            </p>
          )}
        </div>

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
        ) : !connected ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            The server produced no output before it failed. For a stdio server that usually means
            the launcher itself never started — check that the command is spelled correctly and
            that the package exists.
          </p>
        ) : null}

        {tools.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="label text-muted-foreground">Tools it offers</span>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <span
                  key={tool.name}
                  title={tool.description ?? undefined}
                  className="readout rounded-md border px-1.5 py-1 text-[0.625rem] text-muted-foreground"
                >
                  {tool.name}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <p className="text-[0.625rem] leading-relaxed text-muted-foreground">
          {server.lastProbedAt
            ? `Last checked ${new Date(server.lastProbedAt).toLocaleString()}.`
            : 'Never connected successfully.'}
        </p>
      </div>

      <div className="flex items-center gap-2 border-t px-5 py-3.5">
        <Button type="button" size="sm" onClick={onEdit}>
          <PencilIcon data-icon="inline-start" />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void onRetry()}
        >
          {busy ? 'Reconnecting…' : 'Reconnect'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRemove}
          className="ml-auto text-muted-foreground hover:text-destructive"
        >
          Remove
        </Button>
      </div>
    </>
  )
}

/**
 * Confirm removing a server.
 *
 * Says what is actually lost rather than asking "are you sure": the credentials
 * go with the row, so putting it back means retyping a password that only ever
 * existed here. And it names the cheaper thing — turning a server off keeps the
 * connection and takes its tools out of the agent's list, which is what most
 * people reaching for the bin actually want.
 *
 * Built in the dialog rather than with window.confirm, which draws OS chrome
 * that shares nothing with this console and cannot say any of the above.
 */
function ConfirmRemove({
  server,
  onCancel,
  onConfirm,
}: {
  server: McpServerRow
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const connector = matchConnector(server)
  const credentials = [...(server.headerKeys ?? []), ...(server.envKeys ?? [])]

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <ServiceMark connector={connector} transport={server.transport} size="sm" />
          Remove {server.name}?
        </DialogTitle>
        <DialogDescription>
          {server.status === 'connected' && server.toolCount
            ? `Its ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'} stop being available to the agent.`
            : 'It stops being available to the agent.'}
          {credentials.length
            ? ` The ${credentials.length === 1 ? 'credential' : 'credentials'} stored for it ${credentials.length === 1 ? 'is' : 'are'} deleted, so reconnecting means entering ${credentials.length === 1 ? 'it' : 'them'} again.`
            : ''}
        </DialogDescription>
      </DialogHeader>

      <div className={cn(BODY_CLASS, 'flex flex-col gap-2')}>
        {server.enabled ? (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            To stop the agent using it without losing the connection, turn it off instead.
          </p>
        ) : null}
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          Other workspaces keep their own copy.
        </p>
      </div>

      <div className="flex gap-2 border-t px-5 py-3.5">
        <Button type="button" size="sm" variant="destructive" onClick={() => void onConfirm()}>
          <Trash2Icon data-icon="inline-start" />
          Remove
        </Button>
        {/* Cancel takes the focus, because the cost of the two answers is not
            symmetrical: Enter on a dialog you opened by accident should not be
            the keystroke that deletes a password. */}
        <Button type="button" size="sm" variant="ghost" autoFocus onClick={onCancel}>
          Cancel
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
