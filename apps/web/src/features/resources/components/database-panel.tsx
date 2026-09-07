import { useCallback, useEffect, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  DatabaseIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  addConnectionStreaming,
  deleteConnection,
  listConnections,
  refreshConnection,
  testConnection,
  testStoredConnection,
  updateConnection,
  type AttachPhase,
  type DatabaseConnectionInput,
} from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { DbConnectionRow } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'
import {
  connectionInput,
  emptyFormFor,
  engineLabel,
  formatServerVersion,
  formFromConnection,
  type DatabaseFormState as FormState,
} from './database-form'

/**
 * Connect a read-only database and see what the agent can query.
 *
 * A connection that failed to introspect is listed alongside the ones that
 * worked, carrying its reason — the same stance the document panel takes, and
 * for the same reason: an unreachable database looks exactly like an empty one
 * until the agent says it found nothing.
 */
export function DatabasePanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [connections, setConnections] = useState<DbConnectionRow[]>([])
  const [busy, setBusy] = useState(false)
  const [formMode, setFormMode] = useState<FormMode>(null)
  const [form, setForm] = useState(() => emptyFormFor('postgresql'))
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  useEffect(() => onCountChange?.(connections.length), [connections.length, onCountChange])
  const [steps, setSteps] = useState<AttachPhase[]>([])
  const scope = useScope()
  const editing = formMode?.kind === 'edit' ? formMode.connection : null
  const dialogOpen = formMode !== null
  const formReady = Boolean(
    form.name.trim() &&
    form.host.trim() &&
    form.port.trim() &&
    form.database.trim() &&
    form.username.trim() &&
    (editing || form.password),
  )

  const refresh = useCallback(async () => {
    try {
      setConnections(await listConnections(scope))
    } catch {
      // Secondary to the console; a listing failure is not fatal.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = useCallback(async () => {
    if (!formReady) return
    setBusy(true)
    setError(null)
    setSteps([])
    try {
      const input = connectionInput(form, editing)
      const out = editing
        ? await updateConnection(scope, editing.id, input)
        : await addConnectionStreaming(scope, input, (p) => setSteps((prev) => [...prev, p]))
      if (out.error) {
        setError(out.error.message)
        setForm((current) => ({ ...current, password: '', sslCa: '' }))
        return
      }
      if (!out.connection) {
        setError('The API completed without returning the connection')
        return
      }
      setConnections((current) => editing
        ? current.map((connection) => connection.id === out.connection!.id ? out.connection! : connection)
        : [out.connection!, ...current])
      setForm(emptyFormFor('postgresql'))
      setFormMode(null)
      setTestResult(null)
    } catch {
      setError('Could not reach the API')
    } finally {
      setBusy(false)
      // Deliberately NOT cleared here. A local attach finishes in ~20ms, so
      // clearing on completion would mean the user never sees the steps at all
      // — the log survives until the next attach or an explicit cancel, leaving
      // a record of what just happened above the row it produced.
    }
  }, [editing, form, formReady, scope])

  const testSettings = useCallback(async () => {
    if (!formReady) return
    if (editing && !form.password && !matchesSavedConnection(form, editing)) {
      setError('Enter the password to test changed settings. Saving can still preserve the current password.')
      setTestResult(null)
      return
    }
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const result = editing && !form.password
        ? await testStoredConnection(scope, editing.id)
        : await testConnection(scope, connectionInput(form, editing))
      if (result.ok) {
        setTestResult(
          `Connected in ${result.value.latencyMs.toLocaleString()}ms${formatServerVersion(result.value, form.engine)}`,
        )
      } else {
        setError(result.error.message)
      }
    } catch {
      setError('Could not reach the API')
    } finally {
      setBusy(false)
    }
  }, [editing, form, formReady, scope])

  const closeForm = useCallback(() => {
    setFormMode(null)
    setError(null)
    setTestResult(null)
    setForm(emptyFormFor('postgresql'))
    setSteps([])
  }, [])

  const openPicker = useCallback(() => {
    setForm(emptyFormFor('postgresql'))
    setFormMode({ kind: 'pick' })
    setError(null)
    setTestResult(null)
    setSteps([])
  }, [])

  const connected = connections.filter((c) => c.status === 'connected')
  const tableTotal = connected.reduce((n, c) => n + c.tableCount, 0)

  return (
    <div className="flex flex-col">
      <PanelHeader
        busy={busy}
        summary={
          connected.length
            ? `${connected.length} db${connected.length === 1 ? '' : 's'} · ${tableTotal} tables`
            : null
        }
        action={
          connections.length && !dialogOpen ? (
            <Button size="sm" onClick={openPicker}>
              <PlusIcon data-icon="inline-start" />
              Connect database
            </Button>
          ) : null
        }
      />

      {connections.length === 0 ? (
        <PanelEmpty
          icon={DatabaseIcon}
          title="No databases connected"
          description="Choose a database connector and the agent can safely explore its schemas and data."
          action={
            <Button size="sm" onClick={openPicker}>
              <PlusIcon data-icon="inline-start" />
              Connect a database
            </Button>
          }
        />
      ) : null}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeForm()
        }}
      >
        <DialogContent className={cn(formMode?.kind === 'pick' ? 'sm:max-w-4xl' : 'sm:max-w-lg')}>
          {formMode?.kind === 'pick' ? (
            <DatabaseConnectorPicker
              onChoose={(engine) => {
                setForm(emptyFormFor(engine))
                setFormMode({ kind: 'create' })
              }}
            />
          ) : formMode ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {!editing ? (
                    <BackButton onClick={openPicker} />
                  ) : null}
                  {editing ? `Edit ${editing.name} · ${engineLabel(form.engine)}` : engineLabel(form.engine)}
                </DialogTitle>
                <DialogDescription>
                  {editing
                    ? 'Update the connection settings. Leave secret fields blank to keep their saved values.'
                    : `Connect a read-only ${engineLabel(form.engine)} database for schema discovery and safe queries.`}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[min(70vh,36rem)] overflow-y-auto px-5 py-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Name" value={form.name} onChange={(name) => setForm((v) => ({ ...v, name }))} placeholder="sales" />
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Engine
                    <select disabled value={form.engine} className={inputClass}>
                      <option value="postgresql">PostgreSQL</option>
                      <option value="mysql">MySQL / MariaDB</option>
                      <option value="sqlserver">SQL Server</option>
                      <option value="sybase">SAP Sybase ASE</option>
                    </select>
                  </label>
                  <Field label="Host" value={form.host} onChange={(host) => setForm((v) => ({ ...v, host }))} placeholder="10.35.180.238" />
                  <Field label="Port" value={form.port} onChange={(port) => setForm((v) => ({ ...v, port }))} inputMode="numeric" />
                  <Field label="Database" value={form.database} onChange={(database) => setForm((v) => ({ ...v, database }))} placeholder="takaful" />
                  <Field label="Username" value={form.username} onChange={(username) => setForm((v) => ({ ...v, username }))} placeholder="readonly_user" />
                  <Field
                    label={editing ? 'Password (leave blank to keep)' : 'Password'}
                    value={form.password}
                    onChange={(password) => setForm((v) => ({ ...v, password }))}
                    type="password"
                    autoComplete="new-password"
                  />
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    SSL mode
                    <select
                      value={form.sslMode}
                      onChange={(event) => setForm((v) => ({ ...v, sslMode: event.target.value as FormState['sslMode'] }))}
                      className={inputClass}
                    >
                      <option value="disable">Disable</option>
                      {form.engine !== 'sybase' ? (
                        <>
                          <option value="require">Require (no certificate verification)</option>
                          <option value="verify-full">Verify certificate and host</option>
                        </>
                      ) : null}
                    </select>
                  </label>
                  {form.sslMode === 'verify-full' ? (
                    <>
                      <Field label="TLS server name (optional)" value={form.serverName} onChange={(serverName) => setForm((v) => ({ ...v, serverName }))} />
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                        Custom CA PEM {editing?.hasCustomCa ? '(leave blank to keep saved CA)' : '(optional)'}
                        <textarea
                          value={form.sslCa}
                          onChange={(event) => setForm((v) => ({ ...v, sslCa: event.target.value, removeCa: false }))}
                          rows={3}
                          className={inputClass}
                        />
                      </label>
                      {editing?.hasCustomCa ? (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
                          <input type="checkbox" checked={form.removeCa} onChange={(event) => setForm((v) => ({ ...v, removeCa: event.target.checked, sslCa: '' }))} />
                          Remove saved custom CA
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </div>

                {form.engine === 'sqlserver' || form.engine === 'sybase' ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {engineLabel(form.engine)} requires a server-side read-only login.
                  </p>
                ) : null}

                {steps.length ? <div className="mt-3"><AttachLog steps={steps} /></div> : null}
                {error ? <p className="mt-3 text-xs text-muted-foreground">{error}</p> : null}
                {testResult ? <p className="mt-3 text-xs text-muted-foreground">{testResult}</p> : null}

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={busy || !formReady} onClick={() => void testSettings()}>
                    Test connection
                  </Button>
                  <Button type="submit" size="sm" disabled={busy || !formReady}>
                    {busy ? 'Working…' : editing ? 'Save' : 'Connect'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {!dialogOpen && (error || testResult) ? (
        <p className="mt-2 text-xs text-muted-foreground">{error ?? testResult}</p>
      ) : null}

      {!dialogOpen && steps.length ? (
        <div className="mt-2">
          <AttachLog steps={steps} />
        </div>
      ) : null}

      {connections.length ? (
        <PanelGrid>
          {connections.map((c) => (
            <ConnectionItem
              key={c.id}
              connection={c}
              onEdit={() => {
                setFormMode({ kind: 'edit', connection: c })
                setError(null)
                setTestResult(null)
                setSteps([])
                setForm(formFromConnection(c))
              }}
              onTest={async () => {
                setBusy(true)
                setError(null)
                setTestResult(null)
                try {
                  const result = await testStoredConnection(scope, c.id)
                  if (result.ok) {
                    setTestResult(
                      `${c.name}: connected in ${result.value.latencyMs.toLocaleString()}ms${formatServerVersion(result.value, c.engine)}`,
                    )
                  }
                  else setError(result.error.message)
                } catch {
                  setError(`Could not test ${c.name}`)
                } finally {
                  setBusy(false)
                }
              }}
              onRefresh={async () => {
                setBusy(true)
                try {
                  const updated = await refreshConnection(scope, c.id)
                  setConnections((current) => current.map((connection) => connection.id === updated.id ? updated : connection))
                } catch {
                  setError(`Could not refresh ${c.name}`)
                } finally {
                  setBusy(false)
                }
              }}
              onRemove={async () => {
                setConnections((prev) => prev.filter((x) => x.id !== c.id))
                try {
                  await deleteConnection(scope, c.id)
                } catch {
                  setError(`Could not remove ${c.name}`)
                  await refresh()
                }
              }}
              onEditDisabled={Boolean(c.granted)}
            />
          ))}
        </PanelGrid>
      ) : null}
    </div>
  )
}

type FormMode =
  | { kind: 'pick' }
  | { kind: 'create' }
  | { kind: 'edit'; connection: DbConnectionRow }
  | null

const DATABASE_CONNECTORS = [
  {
    engine: 'postgresql',
    name: 'PostgreSQL',
    summary: 'Explore schemas and run guarded, read-only queries.',
    detail: 'Read-only connector · port 5432',
    available: true,
    tint: '51 103 145',
  },
  {
    engine: 'mysql',
    name: 'MySQL',
    summary: 'Connect MySQL-compatible databases with the same safe tools.',
    detail: 'Read-only connector · port 3306',
    available: true,
    tint: '0 117 143',
  },
  {
    engine: 'sqlserver',
    name: 'SQL Server',
    summary: 'Connect Microsoft SQL Server using a read-only database login.',
    detail: 'Read-only login required · port 1433',
    available: true,
    tint: '204 41 38',
  },
  {
    engine: 'sybase',
    name: 'SAP Sybase ASE',
    summary: 'Explore SAP ASE catalogs through FreeTDS with guarded queries.',
    detail: 'Read-only login required · port 5000 · SSL disabled',
    available: true,
    tint: '0 112 192',
  },
] as const

const inputClass = 'rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-foreground/30 disabled:opacity-60'

function DatabaseConnectorPicker({ onChoose }: { onChoose: (engine: DatabaseConnectionInput['engine']) => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect a database</DialogTitle>
        <DialogDescription>
          Choose a database engine. You&apos;ll enter its connection details next.
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 py-4">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {DATABASE_CONNECTORS.map((connector) => (
            <button
              key={connector.engine}
              type="button"
              disabled={!connector.available}
              onClick={() => onChoose(connector.engine)}
              className={cn(
                'flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left',
                'transition-colors outline-none',
                'hover:border-foreground/30 hover:bg-accent',
                'focus-visible:border-foreground/40 focus-visible:bg-accent',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent',
              )}
            >
              <span
                className="mb-1.5 flex size-7 items-center justify-center rounded-md"
                style={{ color: `rgb(${connector.tint})`, backgroundColor: `rgb(${connector.tint} / 0.12)` }}
              >
                <DatabaseIcon className="size-4" />
              </span>
              <span className="text-sm leading-snug">{connector.name}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {connector.summary}
              </span>
              <span className="readout mt-auto w-full truncate pt-2.5 text-[0.625rem] text-muted-foreground/70">
                {connector.detail}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back to database connectors"
      className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
    >
      <ChevronLeftIcon className="size-4" />
    </button>
  )
}

function Field({ label, value, onChange, ...props }: {
  label: string
  value: string
  onChange: (value: string) => void
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input {...props} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass} />
    </label>
  )
}

function matchesSavedConnection(form: FormState, connection: DbConnectionRow): boolean {
  return (
    form.name.trim() === connection.name &&
    form.engine === connection.engine &&
    form.host.trim() === connection.host &&
    Number(form.port) === connection.port &&
    form.database.trim() === connection.database &&
    form.username.trim() === connection.username &&
    form.sslMode === connection.sslMode &&
    !form.sslCa &&
    !form.serverName &&
    !form.removeCa
  )
}

/** One line per phase, in the order the server reported them. */
function describe(p: AttachPhase): string {
  switch (p.phase) {
    case 'connected':
      return 'connected'
    case 'catalog':
      return `${CATALOG_LABEL[p.step] ?? p.step} · ${p.count.toLocaleString()}`
    case 'building':
      return `${p.tables.toLocaleString()} tables · ${p.columns.toLocaleString()} columns`
    case 'indexing':
      return `indexing ${p.entries.toLocaleString()} entries`
    case 'done':
      return `ready in ${p.ms.toLocaleString()}ms`
    case 'failed':
      return `${p.step} failed — ${p.error}`
  }
}

type CatalogStep = Extract<AttachPhase, { phase: 'catalog' }>['step']

const CATALOG_LABEL: Record<CatalogStep, string> = {
  tables: 'tables',
  columns: 'columns',
  primaryKeys: 'primary keys',
  foreignKeys: 'foreign keys',
  indexes: 'indexes',
}

/**
 * The attach, step by step.
 *
 * Introspection is five sequential round trips plus a write, and against a
 * remote database that is long enough for a spinner to read as a hang. Showing
 * the steps also means a failure names the phase it died on — "reading foreign
 * keys failed" is actionable in a way that one opaque error string is not.
 */
function AttachLog({ steps }: { steps: AttachPhase[] }) {
  const last = steps[steps.length - 1]
  const settled = last?.phase === 'done' || last?.phase === 'failed'

  return (
    <ul className="readout flex flex-col gap-0.5 rounded-md border bg-muted/30 px-2 py-1.5 text-[0.625rem]">
      {steps.map((p, i) => {
        const isLast = i === steps.length - 1
        const failed = p.phase === 'failed'
        // Everything before the tail is finished by definition; only the tail
        // can still be in flight.
        const glyph = failed ? '×' : isLast && !settled ? '▸' : '✓'
        return (
          <li
            key={i}
            className={cn(
              'flex gap-1.5 tabular-nums',
              failed ? 'text-foreground' : 'text-muted-foreground',
              isLast && !settled && 'text-foreground',
            )}
          >
            <span aria-hidden className="w-2 shrink-0">
              {glyph}
            </span>
            <span className="min-w-0 break-words">{describe(p)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ConnectionItem({
  connection,
  onEdit,
  onTest,
  onRefresh,
  onRemove,
  onEditDisabled,
}: {
  connection: DbConnectionRow
  onEdit: () => void
  onTest: () => Promise<void>
  onRefresh: () => Promise<void>
  onRemove: () => Promise<void>
  onEditDisabled?: boolean
}) {
  const failed = connection.status !== 'connected'
  const shared = connection.granted === true

  return (
    <ItemCard
      leading={
        failed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {connection.error ?? 'unreachable'}
            </TooltipContent>
          </Tooltip>
        ) : (
          <DatabaseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )
      }
      title={
        <span className={cn(failed && 'text-muted-foreground')}>
          {connection.name}
          {shared ? (
            <span className="ml-2 inline-flex rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-700 dark:text-sky-300">
              Shared with your department
            </span>
          ) : null}
        </span>
      }
      meta={
        failed
          ? 'could not connect'
          : `${engineLabel(connection.engine)} · ${connection.database} @ ${connection.host}:${connection.port} · ${connection.tableCount} tables`
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void onTest()}
            aria-label={`Test ${connection.name}`}
            className="text-muted-foreground"
          >
            <ShieldCheckIcon />
          </Button>
          {onEditDisabled ? null : (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onEdit}
                aria-label={`Edit ${connection.name}`}
                className="text-muted-foreground"
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void onRefresh()}
                aria-label={`Refresh ${connection.name}`}
                className="text-muted-foreground"
              >
                <RefreshCwIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void onRemove()}
                aria-label={`Remove ${connection.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </>
      }
    />
  )
}
