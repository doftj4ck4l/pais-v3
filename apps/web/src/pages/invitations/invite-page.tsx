import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Building2Icon, CheckCircle2Icon, ShieldCheckIcon } from 'lucide-react'
import { acceptInvitation, inspectInvitation } from '@/shared/api/api'
import { BrandMark } from '@/shared/components/brand'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import type { InvitationAcceptance, InvitationInspection } from '@/shared/lib/types'

function captureToken(): string | null {
  const hash = window.location.hash
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const value = params.get('token')?.trim() || null
  // Clear the secret before any later navigation, referrer, or screenshot can
  // retain it. It remains in component memory only for this visit.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}

export function InvitePage() {
  const [token] = useState(captureToken)
  const [inspection, setInspection] = useState<InvitationInspection | null>(null)
  const [accepted, setAccepted] = useState<InvitationAcceptance | null>(null)
  const [loading, setLoading] = useState(!!token)
  const [busy, setBusy] = useState(false)
  const [inspectionError, setInspectionError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let live = true
    inspectInvitation(token)
      .then((result) => {
        if (!live) return
        setInspection(result)
        setInspectionError(null)
      })
      .catch((cause: Error) => live && setInspectionError(cause.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [token])

  const retryInspection = async () => {
    if (!token) return
    setLoading(true)
    setInspectionError(null)
    try {
      setInspection(await inspectInvitation(token))
    } catch (cause) {
      setInspectionError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const accept = async () => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      setAccepted(await acceptInvitation(token))
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const state = accepted ?? inspection

  return (
    <main className="min-h-full bg-muted/20 p-4 sm:grid sm:place-items-center sm:p-8">
      <section className="mx-auto mt-12 w-full max-w-lg overflow-hidden rounded-2xl border bg-background shadow-sm sm:mt-0">
        <header className="flex items-center gap-3 border-b px-5 py-4">
          <BrandMark className="h-8" />
          <span className="ml-auto text-xs text-muted-foreground">Organization invitation</span>
        </header>

        <div className="grid justify-items-center gap-4 p-6 text-center sm:p-8">
          {loading ? (
            <><Spinner className="size-5" /><h1 className="text-base font-semibold">Checking invitation…</h1></>
          ) : !token ? (
            <Terminal
              icon={<ShieldCheckIcon />}
              title="Invitation link unavailable"
              description="Reopen the original invitation link. If you no longer have it, ask the administrator for a replacement."
            />
          ) : inspectionError && !inspection ? (
            <>
              <div role="alert">
                <Terminal
                  icon={<ShieldCheckIcon />}
                  title="Couldn't check invitation"
                  description={inspectionError}
                />
              </div>
              <Button onClick={() => void retryInspection()}>Try again</Button>
            </>
          ) : accepted?.state === 'joined' ? (
            <Terminal
              icon={<CheckCircle2Icon className="text-emerald-600" />}
              title={`You joined ${accepted.organization.name}`}
              description="Your private workspaces stay private. Organization membership does not share or move any of your data."
            />
          ) : state?.state === 'actionable' ? (
            <>
              <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><Building2Icon className="size-5" /></span>
              <div>
                <h1 className="text-lg font-semibold">Join {state.organization.name}</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Joining adds you to this organization. Your workspaces, connectors, documents, and agent runs remain private.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  This invitation expires {new Date(state.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
                </p>
              </div>
              {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
              <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-center">
                <Button asChild variant="outline"><a href="/">Not now</a></Button>
                <Button disabled={busy} onClick={() => void accept()}>{busy ? <Spinner /> : null}Join organization</Button>
              </div>
            </>
          ) : (
            <Terminal
              icon={<ShieldCheckIcon />}
              title={state?.state === 'expired' ? 'Invitation expired' : state?.state === 'revoked' ? 'Invitation revoked' : state?.state === 'used' ? 'Invitation already used' : 'Invitation unavailable'}
              description="This link can no longer be used. Ask the organization administrator for a new invitation if you still need access."
            />
          )}

          {!loading && state?.state !== 'actionable' ? (
            <Button asChild variant="outline" className="mt-2"><a href="/">Go to PixelSpace</a></Button>
          ) : null}
        </div>
      </section>
    </main>
  )
}

function Terminal({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <>
      <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">{icon}</span>
      <div><h1 className="text-lg font-semibold">{title}</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p></div>
    </>
  )
}
