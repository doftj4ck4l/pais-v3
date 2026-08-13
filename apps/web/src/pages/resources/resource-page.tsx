import { AppShell } from '@/features/navigation/components/app-shell'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import type { ReactNode } from 'react'

/**
 * One kind of thing the agent can reach, on a page of its own.
 *
 * Reads as a document rather than a dashboard: the title scrolls with the
 * content, the column is the width of something you would actually read, and
 * the type is a page's type — see `.page-scale`, which undoes the sidebar
 * sizing these panels were drawn at.
 *
 * The body is keyed on the workspace, so switching remounts it: each panel
 * fetches on mount, and re-rendering with a new scope would show the previous
 * workspace's rows until every request came back.
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
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 pt-10 pb-20 sm:px-8">
          <h1 className="text-2xl leading-tight font-bold tracking-[-0.02em]">{title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>

          {/* One surface per page. The panels are lists of rows, and a list
              with nothing under it reads as a page that failed to load. */}
          <div
            key={workspace.current ?? 'none'}
            className="page-scale mt-8 rounded-xl border bg-card p-5 sm:p-6"
          >
            {children}
          </div>
        </div>
      </main>
    </AppShell>
  )
}
