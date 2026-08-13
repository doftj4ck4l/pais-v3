import { useState } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/shared/ui/sheet'
import { AsideCloseContext } from '@/features/navigation/lib/aside-context'
import { SettingsModal } from '@/pages/console/components/settings-modal'
import { Sidebar } from '@/features/navigation/components/sidebar'
import { WorkspaceOnboarding } from '@/features/workspace/components/workspace-onboarding'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
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
 */
export function AppShell({ children }: { children: ReactNode }) {
  const workspace = useWorkspace()
  const board = useBoard()
  const { theme, toggle } = useTheme()
  const sidebar = useSidebar()
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
            would refetch and flash. `w-0` with the content held at its full
            width inside is what makes it slide rather than reflow. */}
        <aside
          className={cn(
            'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-out lg:block',
            'motion-reduce:transition-none',
            sidebar.open ? 'w-64 border-r' : 'w-0',
          )}
        >
          <div className="h-full w-64">
            <Sidebar onOpenSettings={() => setSettingsOpen(true)} onCollapse={sidebar.toggle} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            One bar, two jobs, and which one depends on the width: below `lg`
            the sidebar is a sheet, above it is a column that can be collapsed.
            It is not rendered at all when the column is already showing on a
            wide screen — a control for something you can see is one more thing
            to read.
          */}
          <header
            className={cn(
              'flex items-center gap-3 border-b px-3 py-2.5',
              sidebar.open && 'lg:hidden',
            )}
          >
            <button
              type="button"
              onClick={() => (isWide() ? sidebar.setOpen(true) : setSheetOpen(true))}
              aria-label="Show the sidebar"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <PanelLeftIcon className="size-4" />
            </button>

            <Brand className="h-4 shrink-0" />
          </header>

          {children}
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
          <SheetTitle className="sr-only">Navigation and agents</SheetTitle>
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} onCollapse={null} />
        </SheetContent>
      </Sheet>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        meta={board.meta}
        harnessId={board.harnessId}
        onHarnessChange={board.setHarnessId}
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
