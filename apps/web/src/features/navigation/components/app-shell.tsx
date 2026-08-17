import { useState } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/shared/ui/sheet'
import { AsideCloseContext } from '@/features/navigation/lib/aside-context'
import { SettingsModal } from '@/pages/console/components/settings-modal'
import { Sidebar } from '@/features/navigation/components/sidebar'
import { WorkspaceOnboarding } from '@/features/workspace/components/workspace-onboarding'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useOnChats } from '@/features/navigation/lib/rail'
import { useSidebar } from '@/features/navigation/hooks/use-sidebar'
import { useTheme } from '@/shared/hooks/use-theme'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'
import { Brand } from '@/shared/components/brand'
import type { ReactNode } from 'react'

/**
 * The frame every page is drawn inside: one sidebar, then the page.
 *
 * The sidebar is here rather than in each page so navigating does not tear it
 * down and rebuild it — the agent list would flash on every click — and so the
 * settings modal, which every page can open, has one owner.
 *
 * `topbar` is what a page puts in the bar beside the sidebar toggle — its name,
 * usually. A page that passes one always has the bar; a page that does not (the
 * chat, which names the open agent in its own header) only gets it when there
 * is a sidebar to bring back.
 */
export function AppShell({ topbar, children }: { topbar?: ReactNode; children: ReactNode }) {
  const workspace = useWorkspace()
  const board = useBoard()
  const { theme, toggle } = useTheme()
  const sidebar = useSidebar()
  // The second column only exists on Chats, so only Chats reserves its width.
  const onChats = useOnChats()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Before any workspace exists there is nothing to show and nothing for an
  // agent to act on, so onboarding replaces the whole screen rather than
  // appearing inside a shell full of disabled controls.
  if (workspace.needsOnboarding) {
    return <WorkspaceOnboarding onCreate={workspace.create} />
  }

  return (
    <AsideCloseContext.Provider value={() => setSheetOpen(false)}>
      <div className="relative flex h-full">
        {/* Always mounted, and animated by width rather than by unmounting:
            the sidebar holds the run list, and rebuilding it on every collapse
            would refetch and flash. The content is held at its full width
            inside, which is what makes it slide rather than reflow.

            Collapsing takes the chat list, never the rail: the rail is how you
            leave the page you are on, and a console with no visible way out is
            a console you have to guess at. */}
        <aside
          className={cn(
            'w-14 shrink-0 overflow-hidden border-r transition-[width] duration-300 ease-out',
            'motion-reduce:transition-none',
            sidebar.open && onChats && 'lg:w-[19.5rem]',
          )}
        >
          <div className="h-full w-[19.5rem]">
            <Sidebar onOpenSettings={() => setSettingsOpen(true)} onCollapse={sidebar.toggle} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            One bar, two jobs, and which one depends on the width: below `lg`
            the sidebar is a sheet, above it is a column that can be collapsed.
            Without a `topbar` it is not rendered while the column is already
            showing on a wide screen — a control for something you can see is
            one more thing to read.
          */}
          <header
            className={cn(
              'sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3',
              sidebar.open && onChats && !topbar && 'lg:hidden',
            )}
          >
            <button
              type="button"
              onClick={() => (isWide() ? sidebar.toggle() : setSheetOpen(true))}
              aria-label="Toggle navigation and chat list"
              // The icon rail is always visible, including on narrow screens.
              // Only Chats needs this separate control for its session list.
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                !onChats && 'hidden',
              )}
            >
              <PanelLeftIcon className="size-4" />
            </button>

            {topbar ? (
              <>
                <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
                {topbar}
              </>
            ) : (
              <Brand className="h-4 shrink-0" />
            )}
          </header>

          {children}
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-[19.5rem] gap-0 p-0 sm:max-w-[19.5rem]">
          <SheetTitle className="sr-only">Navigation and agents</SheetTitle>
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} onCollapse={null} />
        </SheetContent>
      </Sheet>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        meta={board.meta}
        modelId={board.modelIdForNew}
        onModelChange={board.setModelIdForNew}
        agentCount={board.agents.length}
        onClearAll={board.clearAll}
        theme={theme}
        onToggleTheme={toggle}
      />
    </AsideCloseContext.Provider>
  )
}

/** Matches the `lg` breakpoint the sidebar column uses. */
function isWide(): boolean {
  return window.matchMedia('(min-width: 1024px)').matches
}
