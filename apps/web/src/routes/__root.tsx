import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { AgentBoardContext, useAgentBoard } from '@/features/agents/hooks/use-agent-board'
import { useWorkspaceState, WorkspaceContext } from '@/features/workspace/hooks/use-workspace'
import { MeContext, useMeState } from '@/features/workspace/hooks/use-me'
import { LoginPage } from '@/pages/auth/login-page'
import { Spinner } from '@/shared/ui/spinner'

/**
 * Everything every route needs, and nothing any single route owns.
 *
 * The workspace lives here rather than in a route because it outlives
 * navigation: switching between the console and the admin page must not
 * re-resolve which workspace is open, or re-fetch the list to find out.
 *
 * The profile is here for a second reason as well: the display name is shown
 * in two places at once, so both have to read the same copy of it.
 *
 * The agent board is here for a third: a run is a live stream held in that
 * hook, and mounting it inside the chat route meant opening any other page
 * abandoned the run that was still arriving.
 */
export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  const me = useMeState()

  if (me.loading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading Pixelspace">
        <Spinner className="size-5" />
      </div>
    )
  }

  if (!me.me) return <LoginPage onSignedIn={me.signedIn} />

  return <AuthenticatedRoot me={me} />
}

function AuthenticatedRoot({ me }: { me: ReturnType<typeof useMeState> }) {
  const workspace = useWorkspaceState()
  const board = useAgentBoard(workspace.scope)

  return (
    <TooltipProvider>
      <MeContext.Provider value={me}>
        <WorkspaceContext.Provider value={workspace}>
          <AgentBoardContext.Provider value={board}>
            <Outlet />
          </AgentBoardContext.Provider>
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
