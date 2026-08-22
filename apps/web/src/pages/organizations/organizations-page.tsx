import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import {
  Building2Icon,
  CopyIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  UserPlusIcon,
} from 'lucide-react'
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
import { ItemCard, PanelEmpty, PanelGrid } from '@/features/resources/components/panel-kit'
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
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="grid w-full gap-6 p-5 md:p-8">
          <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="readout text-xs font-medium tracking-[0.16em] uppercase text-muted-foreground">
                Access
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">Organizations</h1>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
                Group people without sharing their private workspaces. Membership never grants access
                to another person&apos;s workspace.
              </p>
            </div>
            {organizations.length ? (
              <Button size="sm" onClick={() => setForm('create')}>
                <PlusIcon data-icon="inline-start" /> New organization
              </Button>
            ) : null}
          </header>

          {error ? (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <Button variant="outline" size="sm" onClick={() => void refreshSelected()}>
                Retry
              </Button>
            </div>
          ) : null}

          {loading ? (
            <p className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </p>
          ) : organizations.length === 0 ? (
            <PanelEmpty
              icon={Building2Icon}
              title="No organizations yet"
              description="Create the first group, then invite people with a secure one-time link. Membership groups accounts without sharing anyone's private workspace."
              action={
                <Button size="sm" onClick={() => setForm('create')}>
                  <PlusIcon data-icon="inline-start" /> New organization
                </Button>
              }
            />
          ) : (
            <PanelGrid>
              {organizations.map((organization) => (
                <ItemCard
                  key={organization.id}
                  onSelect={() => setSelectedId(organization.id)}
                  label={`Open ${organization.name}`}
                  leading={
                    <span
                      aria-hidden
                      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
                    >
                      <Building2Icon className="size-4" />
                    </span>
                  }
                  title={organization.name}
                  meta={
                    <span className="flex flex-wrap gap-x-2">
                      <span>
                        {organization.memberCount} member{organization.memberCount === 1 ? '' : 's'}
                      </span>
                      {organization.pendingInvitationCount ? (
                        <span>{organization.pendingInvitationCount} pending</span>
                      ) : null}
                    </span>
                  }
                />
              ))}
            </PanelGrid>
          )}
        </div>
      </main>

      <OrganizationDetailDialog
        open={selectedId !== null}
        organization={selected}
        detail={visibleDetail}
        loading={detailLoading}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onRename={() => setForm('rename')}
        onInvite={() => setForm('invite')}
        onRefresh={() => void refreshSelected()}
        onRemoveMember={(row) => setDanger({ kind: 'member', row })}
        onRevokeInvitation={(row) => setDanger({ kind: 'invitation', row })}
      />

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

/**
 * One organization, opened from its card: who is in it and who is invited, with
 * the actions that change that. The list stays a plain grid of cards; the detail
 * that used to fill a second column now lives here, so the page reads the same
 * as every other resource page and the membership tables get the room they need.
 */
function OrganizationDetailDialog({
  open,
  organization,
  detail,
  loading,
  onOpenChange,
  onRename,
  onInvite,
  onRefresh,
  onRemoveMember,
  onRevokeInvitation,
}: {
  open: boolean
  organization: OrganizationSummary | null
  detail: OrganizationDetail | null
  loading: boolean
  onOpenChange: (open: boolean) => void
  onRename: () => void
  onInvite: () => void
  onRefresh: () => void
  onRemoveMember: (row: OrganizationMember) => void
  onRevokeInvitation: (row: OrganizationInvitation) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="truncate">{organization?.name ?? 'Organization'}</DialogTitle>
          <DialogDescription>
            Membership never grants access to another person&apos;s private workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 px-5 py-4">
          <Button variant="outline" size="sm" onClick={onRename}>
            Rename
          </Button>
          <Button size="sm" onClick={onInvite}>
            <UserPlusIcon data-icon="inline-start" /> Invite member
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Refresh organization"
            onClick={onRefresh}
          >
            {loading ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto border-t px-5 py-4">
          {loading && !detail ? (
            <div className="flex items-center gap-2 rounded-lg border p-5 text-sm text-muted-foreground">
              <Spinner /> Loading organization details…
            </div>
          ) : detail ? (
            <>
              <DataSection title="Members" count={detail.members.length}>
                {detail.members.length === 0 ? (
                  <EmptyRows icon={<UserPlusIcon />} text="No members yet. Create an invitation to add someone." />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead className="hidden sm:table-cell">Joined</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.members.map((member) => (
                        <TableRow key={member.id}>
                          <TableCell className="max-w-48 truncate font-medium sm:max-w-none">
                            {member.email}
                          </TableCell>
                          <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                            {when(member.joinedAt)}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${member.email}`}
                              onClick={() => onRemoveMember(member)}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </DataSection>

              <DataSection title="Invitations" count={detail.invitations.length}>
                {detail.invitations.length === 0 ? (
                  <EmptyRows icon={<UserPlusIcon />} text="No invitations yet." />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden md:table-cell">Expires</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.invitations.map((invitation) => (
                        <TableRow key={invitation.id}>
                          <TableCell className="max-w-40 truncate font-medium sm:max-w-none">
                            {invitation.email}
                          </TableCell>
                          <TableCell>
                            <Status state={invitation.state} />
                          </TableCell>
                          <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                            {when(invitation.expiresAt)}
                          </TableCell>
                          <TableCell>
                            {invitation.state === 'actionable' ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Revoke invitation for ${invitation.email}`}
                                onClick={() => onRevokeInvitation(invitation)}
                              >
                                <MoreHorizontalIcon />
                              </Button>
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
      </DialogContent>
    </Dialog>
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
