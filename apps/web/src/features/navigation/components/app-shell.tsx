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
import { BrandMark } from '@/shared/components/brand'
import type { ReactNode } from 'react'
import { usePreferences } from '@/shared/hooks/use-preferences'

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
export function AppShell({
  topbar,
  allowWithoutWorkspace = false,
  children,
}: {
  topbar?: ReactNode
  /** Global administration pages do not require or create a private workspace. */
  allowWithoutWorkspace?: boolean
  children: ReactNode
}) {
  const workspace = useWorkspace()
  const board = useBoard()
  const { theme, toggle } = useTheme()
  const sidebar = useSidebar()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { t } = usePreferences()

  // Before any workspace exists there is nothing to show and nothing for an
  // agent to act on, so onboarding replaces the whole screen rather than
  // appearing inside a shell full of disabled controls.
  if (workspace.needsOnboarding && !allowWithoutWorkspace) {
    return <WorkspaceOnboarding onCreate={workspace.create} />
  }

  return (
    <AsideCloseContext.Provider value={() => setSheetOpen(false)}>
      <div className="relative flex h-full bg-background">
        {/* One labelled column, matching the mental model of a chat product.
            It stays mounted so live chat history does not flash on collapse. */}
        <aside
          className={cn(
            'hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:block',
            'motion-reduce:transition-none',
            sidebar.open ? 'lg:w-[16.25rem]' : 'lg:w-0',
          )}
        >
          <div className="h-full w-[16.25rem]">
            <Sidebar onOpenSettings={() => setSettingsOpen(true)} onCollapse={sidebar.toggle} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={cn(
              'sticky top-0 z-30 flex h-13 shrink-0 items-center gap-2 bg-background/90 px-3 backdrop-blur-sm sm:px-4',
              sidebar.open && !topbar && 'lg:hidden',
            )}
          >
            <button
              type="button"
              onClick={() => (isWide() ? sidebar.toggle() : setSheetOpen(true))}
              aria-label={t('toggleNavigation')}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <PanelLeftIcon className="size-[1.125rem]" />
            </button>

            {topbar ? (
              topbar
            ) : (
              <BrandMark className="h-7 shrink-0" />
            )}
          </header>

          {children}
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-[16.25rem] gap-0 border-0 p-0 sm:max-w-[16.25rem]">
          <SheetTitle className="sr-only">{t('navigationAndAgents')}</SheetTitle>
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
