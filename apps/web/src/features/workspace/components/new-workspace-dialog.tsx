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
import type { WorkspaceRow } from '@/shared/lib/types'

/**
 * Naming a new workspace.
 *
 * The sidebar used to do this in place: the "+" replaced the switcher with a
 * bare input, and a blur anywhere threw away what had been typed. Two things
 * were wrong with that. Losing work to a stray click is not a cancel gesture,
 * it is a bug you cannot report; and the row gave no indication of what a
 * workspace is at the moment you are being asked to name one — the answer was
 * only ever shown on first run.
 *
 * A dialog fixes both by having somewhere to put the sentence, and by making
 * dismissal something you have to mean.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  existing,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing: WorkspaceRow[]
  onCreate: (name: string) => Promise<unknown>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reopening starts clean rather than resuming an abandoned attempt.
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open])

  const trimmed = name.trim()
  // Checked here rather than on the server round trip, so the answer arrives
  // while you are still typing the name that will not work.
  const duplicate = existing.some((w) => w.name.toLowerCase() === trimmed.toLowerCase())

  const submit = async () => {
    if (busy || duplicate) return
    setBusy(true)
    setError(null)
    try {
      // An empty field is a choice, not an error: the server names it
      // "Untitled" and the switcher can rename it. Same rule as first run.
      await onCreate(trimmed || 'Untitled')
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the workspace.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            Each workspace keeps its own agents, documents, databases and files. Nothing is
            shared between them.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-workspace-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="new-workspace-name"
              autoFocus
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Research"
              disabled={busy}
              aria-invalid={duplicate || undefined}
              aria-describedby={duplicate || error ? 'new-workspace-problem' : undefined}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-invalid:border-destructive"
            />
            {duplicate || error ? (
              <p id="new-workspace-problem" className="text-sm text-destructive">
                {duplicate ? `You already have a workspace called "${trimmed}".` : error}
              </p>
            ) : null}
          </div>

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
            <Button type="submit" size="sm" disabled={busy || duplicate}>
              {busy ? 'Creating…' : 'Create workspace'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
