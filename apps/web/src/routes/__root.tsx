import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { useWorkspaceState, WorkspaceContext } from '@/features/workspace/hooks/use-workspace'
import { MeContext, useMeState } from '@/features/workspace/hooks/use-me'

/**
 * Everything every route needs, and nothing any single route owns.
 *
 * The workspace lives here rather than in a route because it outlives
 * navigation: switching between the console and the admin page must not
 * re-resolve which workspace is open, or re-fetch the list to find out.
 *
 * The profile is here for a second reason as well: the display name is shown
 * in two places at once, so both have to read the same copy of it.
 */
export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  const workspace = useWorkspaceState()
  const me = useMeState()

  return (
    <TooltipProvider>
      <MeContext.Provider value={me}>
        <WorkspaceContext.Provider value={workspace}>
          <Outlet />
        </WorkspaceContext.Provider>
      </MeContext.Provider>
    </TooltipProvider>
  )
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium">No such page</p>
      <a href="/" className="text-xs text-muted-foreground underline underline-offset-4">
        Back to the console
      </a>
    </div>
  )
}
