import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { CopyIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, UserPlusIcon } from 'lucide-react'
import {
  createOrganization,
  createOrganizationInvitation,
  getOrganization,
  listOrganizations,
  removeOrganizationMember,
  renameOrganization,
  revokeOrganizationInvitation,
} from '@/shared/api/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Spinner } from '@/shared/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'
import { cn } from '@/shared/lib/utils'
import type {
  OrganizationDetail,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSummary,
} from '@/shared/lib/types'

type FormMode = 'create' | 'rename' | 'invite'
type DestructiveAction =
  | { kind: 'member'; row: OrganizationMember }
  | { kind: 'invitation'; row: OrganizationInvitation }

const dateTimeFormatter = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' })
const when = (timestamp: number) => dateTimeFormatter.format(timestamp)

export function OrganizationsPage() {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OrganizationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormMode | null>(null)
  const [danger, setDanger] = useState<DestructiveAction | null>(null)
  const detailRequest = useRef(0)

  const loadOrganizations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listOrganizations()
      setOrganizations(rows)
      setSelectedId((current) =>
        current && rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null),
      )
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string, clearCurrent = false) => {
    const request = ++detailRequest.current
    if (clearCurrent) setDetail(null)
    setDetailLoading(true)
    setError(null)
    try {
      const next = await getOrganization(id)
      if (request !== detailRequest.current) return
      setDetail(next)
    } catch (cause) {
      if (request !== detailRequest.current) return
      setError((cause as Error).message)
      setDetail(null)
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOrganizations()
  }, [loadOrganizations])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId, true)
    else {
      detailRequest.current += 1
      setDetail(null)
      setDetailLoading(false)
    }
  }, [loadDetail, selectedId])

  const selected = useMemo(
    () => organizations.find((organization) => organization.id === selectedId) ?? null,
    [organizations, selectedId],
  )
  const visibleDetail = detail?.organization.id === selectedId ? detail : null

  const refreshSelected = useCallback(async () => {
    await Promise.all([
      loadOrganizations(),
      selectedId ? loadDetail(selectedId) : Promise.resolve(),
    ])
  }, [loadDetail, loadOrganizations, selectedId])

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
        <div className="grid w-full gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center gap-2.5 border-b px-4 py-3">
              <h2 className="text-base font-semibold">Organizations</h2>
              <span className="text-sm text-muted-foreground">{organizations.length}</span>
              <Button size="icon-sm" className="ml-auto" aria-label="Create organization" onClick={() => setForm('create')}>
                <PlusIcon />
              </Button>
            </div>

            {loading ? (
              <p className="flex items-center gap-2 p-5 text-sm text-muted-foreground"><Spinner /> Loading…</p>
            ) : organizations.length === 0 ? (
              <div className="grid justify-items-start gap-3 p-4">
                <div>
                  <p className="text-base font-medium">No organizations yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">Create the first group, then invite people with a secure link.</p>
                </div>
                <Button size="sm" onClick={() => setForm('create')}><PlusIcon /> Create organization</Button>
              </div>
            ) : (
              <div className="grid max-h-64 overflow-y-auto lg:max-h-[calc(100vh-10rem)]">
                {organizations.map((organization) => (
                  <button
                    key={organization.id}
                    type="button"
                    onClick={() => setSelectedId(organization.id)}
                    aria-pressed={selectedId === organization.id}
                    className={cn(
                      'grid gap-1 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent',
                      selectedId === organization.id && 'bg-accent',
                    )}
                  >
                    <span className="truncate text-base font-medium">{organization.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {organization.memberCount} members · {organization.pendingInvitationCount} pending
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
            {error ? (
              <div role="alert" className="flex items-center gap-3 border-b bg-destructive/5 p-4 text-sm text-destructive">
                <span className="min-w-0 flex-1">{error}</span>
                <Button variant="outline" size="sm" onClick={() => void refreshSelected()}>Retry</Button>
              </div>
            ) : null}

            {!selected ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Create an organization to begin.</div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 border-b p-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-xl font-semibold">{selected.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Membership never grants access to another person&apos;s workspace.</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setForm('rename')}>Rename</Button>
                  <Button size="sm" onClick={() => setForm('invite')}><UserPlusIcon /> Invite member</Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Refresh organization" onClick={() => void refreshSelected()}>
                    {detailLoading ? <Spinner /> : <RefreshCwIcon />}
                  </Button>
                </div>

                <div className="grid gap-5 p-4 xl:grid-cols-2 xl:items-start">
                  {detailLoading && !visibleDetail ? (
                    <div className="flex items-center gap-2 rounded-lg border p-5 text-sm text-muted-foreground xl:col-span-2">
                      <Spinner /> Loading organization details…
                    </div>
                  ) : visibleDetail ? (
                    <>
                  <DataSection title="Members" count={visibleDetail.members.length}>
                    {visibleDetail.members.length === 0 ? (
                      <EmptyRows icon={<UserPlusIcon />} text="No members yet. Create an invitation to add someone." />
                    ) : (
                      <Table>
                        <TableHeader><TableRow><TableHead>Email</TableHead><TableHead className="hidden sm:table-cell">Joined</TableHead><TableHead className="w-10"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
                        <TableBody>
                          {visibleDetail.members.map((member) => (
                            <TableRow key={member.id}>
                              <TableCell className="max-w-48 truncate font-medium sm:max-w-none">{member.email}</TableCell>
                              <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{when(member.joinedAt)}</TableCell>
                              <TableCell>
                                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${member.email}`} onClick={() => setDanger({ kind: 'member', row: member })}><MoreHorizontalIcon /></Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </DataSection>

                  <DataSection title="Invitations" count={visibleDetail.invitations.length}>
                    {visibleDetail.invitations.length === 0 ? (
                      <EmptyRows icon={<UserPlusIcon />} text="No invitations yet." />
                    ) : (
                      <Table>
                        <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Status</TableHead><TableHead className="hidden md:table-cell">Expires</TableHead><TableHead className="w-10"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
                        <TableBody>
                          {visibleDetail.invitations.map((invitation) => (
                            <TableRow key={invitation.id}>
                              <TableCell className="max-w-40 truncate font-medium sm:max-w-none">{invitation.email}</TableCell>
                              <TableCell><Status state={invitation.state} /></TableCell>
                              <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{when(invitation.expiresAt)}</TableCell>
                              <TableCell>
                                {invitation.state === 'actionable' ? (
                                  <Button variant="ghost" size="icon-sm" aria-label={`Revoke invitation for ${invitation.email}`} onClick={() => setDanger({ kind: 'invitation', row: invitation })}><MoreHorizontalIcon /></Button>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </DataSection>
                    </>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      <OrganizationForm
        mode={form}
        organization={selected}
        onOpenChange={(open) => !open && setForm(null)}
        onCreated={(organization) => {
          setOrganizations((rows) => [...rows, organization].sort((a, b) => a.name.localeCompare(b.name)))
          setSelectedId(organization.id)
        }}
        onRenamed={(name) => {
          setOrganizations((rows) => rows.map((row) => row.id === selectedId ? { ...row, name } : row))
          setDetail((current) => current ? { ...current, organization: { ...current.organization, name } } : current)
        }}
        onInvited={(invitation) => {
          if (invitation.organizationId !== detail?.organization.id) return
          const replacesPending = detail.invitations.some(
            (row) => row.state === 'actionable' && row.email === invitation.email,
          )
          setDetail((current) => current?.organization.id === invitation.organizationId ? {
            ...current,
            invitations: [
              invitation,
              ...current.invitations.map((row) =>
                row.state === 'actionable' && row.email === invitation.email
                  ? { ...row, state: 'revoked' as const, revokedAt: invitation.createdAt }
                  : row,
              ),
            ],
          } : current)
          if (!replacesPending) {
            setOrganizations((rows) => rows.map((row) => row.id === invitation.organizationId
              ? { ...row, pendingInvitationCount: row.pendingInvitationCount + 1 }
              : row))
          }
        }}
      />

      <DestructiveDialog
        action={danger}
        organizationId={selectedId}
        onOpenChange={(open) => !open && setDanger(null)}
        onDone={(action) => {
          setDetail((current) => {
            if (!current) return current
            return action.kind === 'member'
              ? { ...current, members: current.members.filter((row) => row.id !== action.row.id) }
              : {
                  ...current,
                  invitations: current.invitations.map((row) => row.id === action.row.id
                    ? { ...row, state: 'revoked' as const, revokedAt: Date.now() }
                    : row),
                }
          })
          setOrganizations((rows) => rows.map((row) => row.id === selectedId
            ? action.kind === 'member'
              ? { ...row, memberCount: Math.max(0, row.memberCount - 1) }
              : { ...row, pendingInvitationCount: Math.max(0, row.pendingInvitationCount - 1) }
            : row))
        }}
      />
    </>
  )
}

function OrganizationForm({
  mode,
  organization,
  onOpenChange,
  onCreated,
  onRenamed,
  onInvited,
}: {
  mode: FormMode | null
  organization: OrganizationSummary | null
  onOpenChange: (open: boolean) => void
  onCreated: (organization: OrganizationSummary) => void
  onRenamed: (name: string) => void
  onInvited: (invitation: OrganizationInvitation) => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setValue(mode === 'rename' ? (organization?.name ?? '') : '')
    setError(null)
    setInviteUrl(null)
    setCopied(false)
  }, [mode, organization?.name])

  if (!mode) return null
  const invite = mode === 'invite'
  const title = mode === 'create' ? 'Create organization' : mode === 'rename' ? 'Rename organization' : 'Invite a member'
  const description = invite
    ? 'The invitation is bound to this email. You will copy and send the one-time link manually.'
    : 'Organization membership groups people without sharing their private workspaces.'

  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError(invite ? 'Enter an email address.' : 'Enter an organization name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'create') {
        onCreated(await createOrganization(trimmed))
        onOpenChange(false)
      } else if (mode === 'rename' && organization) {
        const renamed = await renameOrganization(organization.id, trimmed)
        onRenamed(renamed.name)
        onOpenChange(false)
      } else if (organization) {
        const result = await createOrganizationInvitation(organization.id, trimmed)
        setInviteUrl(result.url)
        onInvited(result.invitation)
      }
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setError(null)
    } catch {
      setError('Clipboard access failed. Select and copy the link manually.')
    }
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (open || !busy) onOpenChange(open)
    }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <div className="grid gap-4 p-5">
          {inviteUrl ? (
            <>
              <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                This link cannot be shown again after you close this dialog. If it is lost, create a replacement invitation.
              </div>
              <div className="grid gap-2">
                <Label htmlFor="organization-invite-url">Invitation link</Label>
                <div className="flex gap-2">
                  <Input id="organization-invite-url" readOnly value={inviteUrl} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                  <Button variant="outline" size="icon" aria-label="Copy invitation link" onClick={() => void copy()}><CopyIcon /></Button>
                </div>
                {copied ? <p className="text-xs text-emerald-600">Copied to clipboard.</p> : null}
              </div>
              {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
              <div className="flex justify-end"><Button onClick={() => onOpenChange(false)}>Done</Button></div>
            </>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="organization-form-value">{invite ? 'Email address' : 'Name'}</Label>
                <Input
                  id="organization-form-value"
                  type={invite ? 'email' : 'text'}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  maxLength={invite ? 254 : 80}
                  autoComplete={invite ? 'email' : 'off'}
                  autoFocus
                  aria-invalid={!!error}
                  aria-describedby={error ? 'organization-form-error' : undefined}
                />
                {error ? <p id="organization-form-error" role="alert" className="text-xs text-destructive">{error}</p> : null}
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}{mode === 'create' ? 'Create' : mode === 'rename' ? 'Save' : 'Create link'}</Button>
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DestructiveDialog({
  action,
  organizationId,
  onOpenChange,
  onDone,
}: {
  action: DestructiveAction | null
  organizationId: string | null
  onOpenChange: (open: boolean) => void
  onDone: (action: DestructiveAction) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!action || !organizationId) return null
  const member = action.kind === 'member'
  const email = action.row.email

  const confirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (action.kind === 'member') await removeOrganizationMember(organizationId, action.row.id)
      else await revokeOrganizationInvitation(organizationId, action.row.id)
      onDone(action)
      onOpenChange(false)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{member ? `Remove ${email}?` : `Revoke invitation for ${email}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {member
              ? 'This removes organization membership only. Their account, private workspaces, and data remain untouched.'
              : 'The existing link will stop working. You can create a replacement invitation later.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={(event) => void confirm(event)}>
            {busy ? <Spinner /> : null}{member ? 'Remove member' : 'Revoke invitation'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DataSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="overflow-hidden rounded-lg border"><div className="flex items-center gap-2.5 border-b px-4 py-3"><h3 className="text-base font-medium">{title}</h3><span className="text-sm text-muted-foreground">{count}</span></div>{children}</section>
}

function EmptyRows({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="flex items-center gap-2.5 p-5 text-sm text-muted-foreground"><span className="[&_svg]:size-4.5">{icon}</span>{text}</div>
}

function Status({ state }: { state: OrganizationInvitation['state'] }) {
  const label = state === 'actionable' ? 'Pending' : state === 'used' ? 'Accepted' : state[0]!.toUpperCase() + state.slice(1)
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs', state === 'actionable' ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : state === 'used' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>{label}</span>
}
