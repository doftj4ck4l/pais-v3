import type React from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMe } from '@/hooks/use-me'

/**
 * First run: no workspaces yet, so ask for one before showing the console.
 *
 * The server used to create "Default" the first time anything listed
 * workspaces, which meant a new account arrived at a console already holding a
 * body of work it had not asked for and had no reason to trust. Naming it is
 * the first thing worth doing, and it costs one field.
 *
 * Only reachable when the list is genuinely empty — deleting the last workspace
 * is refused by the API, so this is not a state an existing user can fall back
 * into by accident.
 */
export function WorkspaceOnboarding({
  onCreate,
}: {
  onCreate: (name: string) => Promise<unknown>
}) {
  const me = useMe()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const greeting = me?.name || me?.username
  const trimmed = name.trim()

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      // An empty field is a valid choice, not an error to block on: the server
      // names it "Untitled" and it can be renamed from the switcher.
      await onCreate(trimmed || 'Untitled')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <span className="mb-5 flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
          <span className="-mt-0.5 font-[family-name:var(--font-mono)] text-lg leading-none">π</span>
        </span>

        <h1 className="text-lg font-semibold tracking-[-0.01em]">
          {greeting ? `Welcome, ${greeting}` : 'Welcome to SalurAI'}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          A workspace holds one body of work — its agents, documents, databases and files. Name your
          first one to get started.
        </p>

        <form
          className="mt-5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            placeholder="Research"
            aria-label="Workspace name"
            disabled={busy}
            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </form>
      </div>
    </div>
  )
}
