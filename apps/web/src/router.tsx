import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/**
 * The router, built once at module scope.
 *
 * Kept out of `main.tsx` so the type registration below has a module to live
 * in, and so tests or tooling can import the router without mounting the app.
 */
export const router = createRouter({
  routeTree,
  // Prefetch a route's code as soon as the pointer lands on its link. The
  // admin page is code-split, and without this the first click pays for the
  // chunk download before anything renders.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

/**
 * Teaches TypeScript about this specific route tree, which is what makes
 * `<Link to="...">` and `useParams()` checked rather than stringly-typed.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
