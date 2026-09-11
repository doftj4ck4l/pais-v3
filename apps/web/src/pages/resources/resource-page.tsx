import { AppShell } from '@/features/navigation/components/app-shell'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'
import type { ReactNode } from 'react'

/**
 * One kind of thing the agent can reach, on a page of its own.
 *
 * The name lives in the top bar beside the sidebar toggle, not in a banner
 * above the content: a display-sized heading over a list of four rows spends
 * the top of the window on a word you already clicked. The content then takes
 * the full width — these are tables and lists, and a reading column down the
 * middle of a wide screen left the right half empty.
 *
 * The body is keyed on the workspace, so switching remounts it: each panel
 * fetches on mount, and re-rendering with a new scope would show the previous
 * workspace's rows until every request came back.
 */
export function ResourcePage({
  title,
  description,
  fullBleed = false,
  children,
}: {
  title: string
  description: string
  /** Let browser-style resources use every pixel below the top bar. */
  fullBleed?: boolean
  children: ReactNode
}) {
  const workspace = useWorkspace()

  return (
    <AppShell
      topbar={
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="shrink-0 text-base font-medium tracking-[-0.015em]">{title}</h1>
          {/* Dropped rather than wrapped on a narrow screen: the title is the
              part you navigated for. */}
          <p className="hidden truncate text-xs text-muted-foreground lg:block">{description}</p>
        </div>
      }
    >
      <main
        className={cn(
          'min-h-0 flex-1',
          fullBleed ? 'overflow-hidden' : 'overflow-y-auto px-4 py-5 sm:px-8 sm:py-7',
        )}
      >
        {/* No surface of its own: what a page lists is a grid of cards, and a
            card holding cards is a border around a border. */}
        <div
          key={workspace.current ?? 'none'}
          className={cn(
            'page-scale w-full',
            fullBleed ? 'h-full min-h-0' : 'mx-auto max-w-6xl',
          )}
        >
          {children}
        </div>
      </main>
    </AppShell>
  )
}
