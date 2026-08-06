import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspaceState, WorkspaceContext } from '@/hooks/use-workspace'

/**
 * Everything every route needs, and nothing any single route owns.
 *
 * The workspace lives here rather than in a route because it outlives
 * navigation: switching between the console and the admin page must not
 * re-resolve which workspace is open, or re-fetch the list to find out.
 */
export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  const workspace = useWorkspaceState()

  return (
    <TooltipProvider>
      <WorkspaceContext.Provider value={workspace}>
        <Outlet />
      </WorkspaceContext.Provider>
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
