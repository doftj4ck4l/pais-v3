import { useRouterState } from '@tanstack/react-router'

/**
 * Whether the sidebar's second column has anything to show.
 *
 * The rail is always there; the column beside it is the chat list, and the
 * chat list belongs to one route. Both the sidebar (which draws the column) and
 * the shell (which reserves the width for it) need to agree about that, and
 * when they did not the result was a 19.5rem strip of empty sidebar down the
 * left of every other page. One rule, imported twice, rather than two
 * conditions that have to be kept the same by hand.
 *
 * Exact, because `/` is a prefix of every other route.
 */
export function useOnChats(): boolean {
  return useRouterState({ select: (s) => s.location.pathname === '/' })
}
