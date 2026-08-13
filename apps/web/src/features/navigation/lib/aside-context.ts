import { createContext, useContext } from 'react'

/**
 * Closes the second column when it is a sheet.
 *
 * On a narrow screen the agent list is a sheet over the page, so choosing an
 * agent has to dismiss it — otherwise you pick a transcript and keep looking at
 * the list. On a wide screen the column is always there and this is a no-op,
 * which is why it is a callback rather than each caller checking the width.
 */
export const AsideCloseContext = createContext<() => void>(() => {})

export function useCloseAside(): () => void {
  return useContext(AsideCloseContext)
}
