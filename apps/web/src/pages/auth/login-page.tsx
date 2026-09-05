import { useEffect, useMemo, useState, type ComponentProps, type FormEvent } from 'react'
import { ArrowRightIcon, LockKeyholeIcon, ServerIcon, ShieldCheckIcon } from 'lucide-react'
import { Brand } from '@/shared/components/brand'
import { fetchAuthConfig, loginWithPassword } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Spinner } from '@/shared/ui/spinner'
import type { AuthConfig, UserProfile } from '@/shared/lib/types'
import { usePreferences } from '@/shared/hooks/use-preferences'

/**
 * The one screen shown before a session exists.
 *
 * The left panel is deliberately dark in both themes: it is the "machine", and
 * the teal wordmark — whose darker half washes out on a pale ground — only ever
 * sits on the black it was drawn for. The pixel matrix behind it is the logo's
 * own grid, thinned left-to-right so the mark reads as the field resolving into
 * a name. The right panel is the console proper and follows the app theme.
 */
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
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : t('unableLoadSignIn')))
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
    <main className="min-h-full w-full overflow-x-hidden lg:grid lg:grid-cols-[1.05fr_1fr]">
      <MachinePanel />

      <section className="flex min-w-0 min-h-[34rem] items-center justify-center px-6 py-14 sm:px-10 lg:px-[clamp(3rem,6vw,7rem)]">
        <div className="w-full max-w-md">
          {/* The brand panel is desktop-only, so the wordmark rides the form on
              small screens. It keeps its dark ground here too, where it reads. */}
          <div
            className="mb-10 inline-flex rounded-lg px-3 py-2 lg:hidden"
            style={{ background: '#05080b' }}
          >
            <Brand className="h-5 brightness-110" />
          </div>
          <div className="flex size-11 items-center justify-center rounded-xl border bg-muted/50">
            <LockKeyholeIcon className="size-5" />
          </div>
          <p className="mt-8 font-mono text-[0.6875rem] uppercase tracking-[0.24em] text-muted-foreground">
            {t('operatorAccess')}
          </p>
          <h2 className="mt-2 text-[2rem] font-semibold leading-none tracking-[-0.04em] sm:text-[2.4rem]">
            {t('signIn')}
          </h2>

          {!config && !error ? (
            <div className="mt-10 flex items-center gap-3 text-sm text-muted-foreground">
              <Spinner className="size-4" /> {t('checkingDeployment')}
            </div>
          ) : config?.passwordLogin ? (
            <form className="mt-9 space-y-5" onSubmit={submit}>
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
              <Button
                type="submit"
                size="lg"
                disabled={busy}
                className="group h-12 w-full justify-between px-5 text-sm"
              >
                <span>{busy ? t('signingIn') : t('signIn')}</span>
                {busy ? (
                  <Spinner className="size-4" />
                ) : (
                  <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                )}
              </Button>
            </form>
          ) : (
            <div className="mt-9 border-l-2 border-foreground pl-5">
              <p className="text-sm font-medium">{t('managedSignIn')}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t('managedSignInHelp')}
              </p>
              <Button type="button" variant="outline" className="mt-5" onClick={() => window.location.reload()}>
                {t('tryAgain')}
              </Button>
            </div>
          )}

          {error && !config?.passwordLogin ? (
            <p role="alert" className="mt-6 text-sm leading-6 text-destructive">
              {error}
            </p>
          ) : null}

          <p className="mt-14 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground/70">
            {t('controlPlaneMachine')}
          </p>
        </div>
      </section>
    </main>
  )
}

/** Labelled input, so the two fields cannot drift apart. */
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
      <Label htmlFor={id} className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 text-base"
        {...rest}
      />
    </div>
  )
}

/**
 * The always-dark brand panel: the wordmark emerging from its own pixel grid.
 *
 * The matrix is one SVG of small squares whose opacity fades left-to-right and a
 * handful of which glow teal. It is decorative, so it is hidden from assistive
 * tech and frozen flat under reduced-motion.
 */
function MachinePanel() {
  const { t } = usePreferences()
  return (
    <section
      className="relative hidden overflow-hidden lg:flex lg:min-h-screen lg:flex-col lg:justify-between"
      style={{ background: 'radial-gradient(120% 120% at 12% 8%, #0b1620 0%, #060a0f 42%, #04070a 100%)' }}
    >
      <PixelMatrix />

      {/* Scrims keep text crisp over the matrix without hiding it: the copy sits
          low-left, so that corner is darkened while the field stays visible above. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(to top, rgba(4,7,10,0.92) 4%, rgba(4,7,10,0.5) 34%, transparent 62%)' }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(100deg, rgba(4,7,10,0.55) 0%, transparent 46%)' }}
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 right-0 w-px"
        style={{ background: 'linear-gradient(to bottom, transparent, #2fb9ae 30%, #2e7fb0 70%, transparent)' }}
        aria-hidden
      />

      <div className="relative px-10 pt-12 lg:px-14">
        <Brand className="h-6 brightness-110" />
      </div>

      <div className="relative max-w-xl px-10 pb-4 lg:px-14">
        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.26em] text-[#5fd7c9]">{t('privateDeployment')}</p>
        <h1 className="mt-5 text-[clamp(2.4rem,4.4vw,4.4rem)] font-semibold leading-[0.95] tracking-[-0.055em] text-white">
          {t('yourModels')}
          <br />
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: 'linear-gradient(92deg, #6fe6d4, #3aa6cc)' }}
          >
            {t('yourInfrastructure')}
          </span>
        </h1>
        <p className="mt-6 max-w-md text-[0.95rem] leading-7 text-white/55">
          {t('privateDeploymentHelp')}
        </p>
      </div>

      <div className="relative flex flex-wrap gap-x-6 gap-y-3 px-10 pb-12 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-white/45 lg:px-14">
        <span className="inline-flex items-center gap-2">
          <ServerIcon className="size-3.5 text-[#5fd7c9]" /> {t('onPrem')}
        </span>
        <span className="inline-flex items-center gap-2">
          <ShieldCheckIcon className="size-3.5 text-[#5fd7c9]" /> {t('privateSession')}
        </span>
      </div>
    </section>
  )
}

const MATRIX_COLS = 42
const MATRIX_ROWS = 30
const CELL = 16
const DOT = 5

/** Deterministic teal pixel field — dense at the left edge, thinning right. */
function PixelMatrix() {
  const cells = useMemo(() => {
    const out: { x: number; y: number; o: number; glow: boolean }[] = []
    for (let row = 0; row < MATRIX_ROWS; row++) {
      for (let col = 0; col < MATRIX_COLS; col++) {
        // Density falls off to the right and softens at the vertical edges, so
        // the field is thickest where the wordmark sits and dissolves outward.
        const across = 1 - col / MATRIX_COLS
        const edge = 1 - Math.abs(row / (MATRIX_ROWS - 1) - 0.5) * 1.2
        const seed = (row * 928371 + col * 12547) % 100
        const base = Math.pow(across, 2.4) * Math.max(0, edge)
        if (base * 100 < seed * 0.72) continue
        const o = Math.min(0.42, 0.05 + base * 0.5)
        out.push({ x: col * CELL, y: row * CELL, o, glow: seed > 92 && across > 0.5 })
      }
    }
    return out
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <style>{`
        @keyframes psx-twinkle { 0%,100% { opacity:.25 } 50% { opacity:1 } }
        @media (prefers-reduced-motion: reduce) { .psx-glow { animation: none !important } }
      `}</style>
      <svg
        className="absolute -top-10 left-0 h-[130%] w-[80%]"
        viewBox={`0 0 ${MATRIX_COLS * CELL} ${MATRIX_ROWS * CELL}`}
        preserveAspectRatio="xMinYMid slice"
      >
        {cells.map((c, i) => (
          <rect
            key={i}
            x={c.x}
            y={c.y}
            width={DOT}
            height={DOT}
            rx={1.2}
            fill={c.glow ? '#6fe6d4' : '#2fb9ae'}
            opacity={c.o}
            className={c.glow ? 'psx-glow' : undefined}
            style={c.glow ? { animation: `psx-twinkle ${3 + (i % 4)}s ease-in-out ${(i % 7) * 0.4}s infinite` } : undefined}
          />
        ))}
      </svg>
    </div>
  )
}
