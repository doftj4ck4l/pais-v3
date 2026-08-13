import { AppShell } from '@/features/navigation/components/app-shell'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import type { ReactNode } from 'react'

/**
 * One kind of thing the agent can reach, on a page of its own.
 *
 * These were six tabs in a 288px drawer, which is why they are all lists of
 * one line each. The page keeps the reading column narrow — a table of
 * documents does not get better at 1600px — but the panels can now grow into
 * something wider than a sidebar when they need to.
 *
 * Keyed on the workspace by the caller's `key`, so switching remounts the body:
 * each panel fetches on mount, and re-rendering with a new scope would show the
 * previous workspace's rows until every request came back.
 */
export function ResourcePage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  const workspace = useWorkspace()

  return (
    <AppShell>
      <header className="border-b px-6 py-4">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="text-[0.9375rem] leading-snug font-bold tracking-[-0.01em]">{title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div key={workspace.current ?? 'none'} className="mx-auto w-full max-w-3xl">
          {children}
        </div>
      </main>
    </AppShell>
  )
}
