import type React from 'react'
import { useState } from 'react'
import { Button } from '@/shared/ui/button'
import { useMe } from '@/features/workspace/hooks/use-me'
import { Brand } from '@/shared/components/brand'
import { usePreferences } from '@/shared/hooks/use-preferences'

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
  const { t } = usePreferences()

  const greeting = me?.name || me?.username
  const trimmed = name.trim()

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      // An empty field is a valid choice, not an error to block on: the server
      // names it "Untitled" and it can be renamed from the switcher.
      await onCreate(trimmed || t('untitled'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Brand className="mb-5 h-16" />

        <h1 className="text-lg font-semibold tracking-[-0.01em]">
          {greeting ? t('welcomeName', { name: greeting }) : t('welcomePixelspace')}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t('onboardingDescription')}
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
            placeholder={t('research')}
            aria-label={t('workspaceName')}
            disabled={busy}
            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={busy}>
            {busy ? t('creating') : t('create')}
          </Button>
        </form>
      </div>
    </div>
  )
}
