import { useState } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/shared/ui/sheet'
import { AsideCloseContext } from '@/features/navigation/lib/aside-context'
import { NavRail } from '@/features/navigation/components/nav-rail'
import { SettingsModal } from '@/pages/console/components/settings-modal'
import { WorkspaceOnboarding } from '@/features/workspace/components/workspace-onboarding'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useTheme } from '@/shared/hooks/use-theme'
import { useWorkspace } from '@/features/workspace/hooks/use-workspace'
import { Brand } from '@/shared/components/brand'
import type { ReactNode } from 'react'

/**
 * The frame every page is drawn inside: the rail on the left, an optional
 * second column, then the page.
 *
 * The rail is here rather than in each page so navigating does not tear it
 * down and rebuild it, and so the settings modal — which every page can open —
 * has one owner.
 */
export function AppShell({
  aside,
  asideLabel = 'Menu',
  children,
}: {
  /** A second column, for a page that has its own navigation (the agent list). */
  aside?: ReactNode
  asideLabel?: string
  children: ReactNode
}) {
  const workspace = useWorkspace()
  const board = useBoard()
  const { theme, toggle } = useTheme()
  const [asideOpen, setAsideOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Before any workspace exists there is nothing to show and nothing for an
  // agent to act on, so onboarding replaces the whole screen rather than
  // appearing inside a shell full of disabled controls.
  if (workspace.needsOnboarding) {
    return <WorkspaceOnboarding onCreate={workspace.create} />
  }

  return (
    <AsideCloseContext.Provider value={() => setAsideOpen(false)}>
      <div className="relative flex h-full">
        <NavRail onOpenSettings={() => setSettingsOpen(true)} />

        {aside ? <aside className="hidden w-72 shrink-0 border-r lg:block">{aside}</aside> : null}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Narrow only: the second column becomes a sheet, and this is the
              handle for it. Pages without one get no bar. */}
          {aside ? (
            <header className="flex items-center gap-3 border-b px-3 py-2.5 lg:hidden">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setAsideOpen(true)}
                aria-label={`Open ${asideLabel.toLowerCase()}`}
              >
                <PanelLeftIcon />
              </Button>
              <Brand className="h-4 shrink-0" />
            </header>
          ) : null}

          {children}
        </div>
      </div>

      {aside ? (
        <Sheet open={asideOpen} onOpenChange={setAsideOpen}>
          <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
            <SheetTitle className="sr-only">{asideLabel}</SheetTitle>
            {aside}
          </SheetContent>
        </Sheet>
      ) : null}

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
