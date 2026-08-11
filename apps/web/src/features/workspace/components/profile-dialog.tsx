import type React from 'react'
import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Button } from '@/shared/ui/button'
import { updateMe } from '@/shared/api/api'
import { useMeContext } from '@/features/workspace/hooks/use-me'

/**
 * Your profile, and the one part of it this console owns.
 *
 * The name is ours: it is stored here and used for the greeting and the badge.
 * Everything else comes from the identity provider on every request, so it is
 * shown but not editable. Writing an email or a group here would produce a
 * console that disagrees with every other app behind the same login, and the
 * next request's headers would overwrite it anyway.
 */
export function ProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { me, refresh } = useMeContext()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seeded on open rather than on mount: the dialog outlives each visit to it,
  // and reopening should show what is stored now, not what was typed last time.
  useEffect(() => {
    if (open) {
      setName(me?.displayName ?? '')
      setError(null)
    }
  }, [open, me?.displayName])

  if (!me) return null

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await updateMe(name.trim())
      refresh()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your name.')
    } finally {
      setBusy(false)
    }
  }

  // What clearing the field would leave you with, which is not the same as
  // what the field currently shows.
  const fallbackName = me.providerName || me.username || me.email || me.id
  const identity = me.username || me.email || me.id

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Profile</DialogTitle>
          <DialogDescription>
            Your name is used for the greeting and the badge in the sidebar.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="profile-name"
              autoFocus
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder={fallbackName}
              disabled={busy}
              maxLength={80}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            />
            <p className="text-xs text-muted-foreground">
              Leave it empty to use {fallbackName}, the name your sign-in provides.
            </p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <Field label="Signed in as" value={identity} />
          {me.email && me.email !== identity ? (
            <Field label="Email" value={me.email} />
          ) : null}
          {me.groups.length ? <Field label="Groups" value={me.groups.join(', ')} /> : null}

          <p className="text-xs text-muted-foreground">
            Those come from your sign-in and are managed there, not here.
          </p>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t pt-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="readout min-w-0 truncate text-right">{value}</span>
    </div>
  )
}
