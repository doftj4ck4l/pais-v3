import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRightIcon, LockKeyholeIcon, ServerIcon, ShieldCheckIcon } from 'lucide-react'
import { Brand } from '@/shared/components/brand'
import { fetchAuthConfig, loginWithPassword } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Spinner } from '@/shared/ui/spinner'
import type { AuthConfig, UserProfile } from '@/shared/lib/types'

export function LoginPage({ onSignedIn }: { onSignedIn: (profile: UserProfile) => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetchAuthConfig()
      .then((value) => live && setConfig(value))
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : 'Unable to load sign-in.'))
    return () => {
      live = false
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await loginWithPassword(email, password))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-full bg-background text-foreground">
      <div className="mx-auto grid min-h-full w-full max-w-[90rem] lg:grid-cols-[minmax(22rem,0.9fr)_minmax(30rem,1.1fr)]">
        <section className="relative flex min-h-[18rem] flex-col justify-between overflow-hidden border-b bg-muted/45 px-6 py-7 sm:px-10 lg:min-h-screen lg:border-r lg:border-b-0 lg:px-14 lg:py-12">
          <Brand className="h-5 sm:h-6" />

          <div className="relative mt-16 max-w-xl lg:mt-0">
            <div className="absolute -left-6 top-1 h-[calc(100%-0.25rem)] w-px bg-gradient-to-b from-brand-from via-brand-to to-transparent sm:-left-10" />
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.24em] text-muted-foreground">
              Private deployment
            </p>
            <h1 className="mt-4 max-w-lg text-[clamp(2.15rem,5vw,4.8rem)] leading-[0.96] font-semibold tracking-[-0.055em]">
              Your models.<br />Your infrastructure.
            </h1>
            <p className="mt-6 max-w-md text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
              Sign in to the Pixelspace control plane running on this machine.
            </p>
          </div>

          <div className="mt-12 flex flex-wrap gap-x-6 gap-y-3 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="inline-flex items-center gap-2"><ServerIcon className="size-3.5" /> On-prem</span>
            <span className="inline-flex items-center gap-2"><ShieldCheckIcon className="size-3.5" /> Private session</span>
          </div>
        </section>

        <section className="flex min-h-[34rem] items-center px-6 py-12 sm:px-10 lg:px-[clamp(4rem,8vw,9rem)]">
          <div className="w-full max-w-lg">
            <div className="flex size-12 items-center justify-center rounded-2xl border bg-muted/55">
              <LockKeyholeIcon className="size-5" />
            </div>
            <p className="mt-8 font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-muted-foreground">
              Operator access
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Sign in to Pixelspace</h2>

            {!config && !error ? (
              <div className="mt-10 flex items-center gap-3 text-sm text-muted-foreground">
                <Spinner className="size-4" /> Checking this deployment…
              </div>
            ) : config?.passwordLogin ? (
              <form className="mt-9 space-y-5" onSubmit={submit}>
                <div className="space-y-2">
                  <Label htmlFor="login-email">Email</Label>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="h-12 text-base"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password">Password</Label>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="h-12 text-base"
                  />
                </div>
                {error ? <p role="alert" className="text-sm leading-6 text-destructive">{error}</p> : null}
                <Button type="submit" size="lg" disabled={busy} className="h-12 w-full justify-between px-5 text-sm">
                  <span>{busy ? 'Signing in…' : 'Sign in'}</span>
                  {busy ? <Spinner className="size-4" /> : <ArrowRightIcon className="size-4" />}
                </Button>
              </form>
            ) : (
              <div className="mt-9 border-l-2 border-foreground pl-5">
                <p className="text-sm font-medium">Sign-in is managed by this deployment’s identity provider.</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Return through your organization’s Pixelspace link. If this page keeps appearing, ask the operator to renew the proxy session.
                </p>
                <Button type="button" variant="outline" className="mt-5" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              </div>
            )}

            {error && !config?.passwordLogin ? (
              <p role="alert" className="mt-6 text-sm leading-6 text-destructive">{error}</p>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  )
}
