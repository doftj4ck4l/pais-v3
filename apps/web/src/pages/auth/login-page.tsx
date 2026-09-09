import { useEffect, useState, type ComponentProps, type FormEvent } from 'react'
import { Brand, BrandMark } from '@/shared/components/brand'
import { fetchAuthConfig, loginWithPassword } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Spinner } from '@/shared/ui/spinner'
import type { AuthConfig, UserProfile } from '@/shared/lib/types'
import { usePreferences } from '@/shared/hooks/use-preferences'

/** The same quiet, focused entry point as the conversation it opens. */
export function LoginPage({ onSignedIn }: { onSignedIn: (profile: UserProfile) => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = usePreferences()

  useEffect(() => {
    let live = true
    fetchAuthConfig()
      .then((value) => live && setConfig(value))
      .catch((cause: unknown) =>
        live && setError(cause instanceof Error ? cause.message : t('unableLoadSignIn')),
      )
    return () => {
      live = false
    }
  }, [t])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await loginWithPassword(email, password))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('signInFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="relative flex min-h-full items-center justify-center bg-background px-6 py-16">
      <Brand className="absolute top-6 left-6 h-5 sm:top-8 sm:left-8" />

      <section className="w-full max-w-sm text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <BrandMark className="h-5" />
        </span>
        <h1 className="mt-7 text-[2rem] font-semibold tracking-[-0.04em]">{t('signIn')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {config?.passwordLogin ? t('operatorAccess') : t('managedSignIn')}
        </p>

        {!config && !error ? (
          <div className="mt-9 flex items-center justify-center gap-2.5 text-sm text-muted-foreground">
            <Spinner className="size-4" /> {t('checkingDeployment')}
          </div>
        ) : config?.passwordLogin ? (
          <form className="mt-8 space-y-4 text-left" onSubmit={submit}>
            <Field
              id="login-email"
              label={t('email')}
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={setEmail}
            />
            <Field
              id="login-password"
              label={t('password')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />
            {error ? (
              <p role="alert" className="text-sm leading-6 text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
              {busy ? <Spinner className="size-4" /> : null}
              {busy ? t('signingIn') : t('signIn')}
            </Button>
          </form>
        ) : (
          <div className="mt-8 rounded-2xl bg-muted p-5 text-left">
            <p className="text-sm leading-6 text-muted-foreground">{t('managedSignInHelp')}</p>
            <Button
              type="button"
              variant="outline"
              className="mt-4 w-full bg-background"
              onClick={() => window.location.reload()}
            >
              {t('tryAgain')}
            </Button>
          </div>
        )}

        {error && !config?.passwordLogin ? (
          <p role="alert" className="mt-5 text-sm leading-6 text-destructive">
            {error}
          </p>
        ) : null}

        <p className="mt-10 text-xs text-muted-foreground">{t('privateSession')}</p>
      </section>
    </main>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  ...rest
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
} & Omit<ComponentProps<typeof Input>, 'id' | 'value' | 'onChange'>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <Input
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 rounded-xl text-base"
        {...rest}
      />
    </div>
  )
}
