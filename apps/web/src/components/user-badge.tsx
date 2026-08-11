import { LogOutIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMe } from '@/hooks/use-me'

/**
 * Who you are signed in as, and how to stop being them.
 *
 * The console has no login of its own — authentication happens at the proxy —
 * so without this there is no way to tell an authenticated session from an
 * open door except by leaving the app and asking the identity provider.
 *
 * Sign-out is a plain link rather than a fetch: it hands the browser to the
 * proxy's own endpoint, which clears the session cookie and redirects. Doing
 * it over XHR would clear the cookie while leaving a stale console on screen.
 */
export function UserBadge() {
  const me = useMe()

  if (!me) return null

  const label = me.name || me.username || me.id
  const secondary = me.email ?? (me.username && me.name ? me.username : null)

  return (
    <div className="flex items-center gap-2 border-t px-3 py-2.5">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-semibold uppercase text-muted-foreground"
      >
        {label.slice(0, 2)}
      </span>

      <span className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-medium">{label}</span>
        {secondary ? (
          <span className="block truncate text-[0.6875rem] text-muted-foreground">{secondary}</span>
        ) : null}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            aria-label="Sign out"
          >
            <a href="/outpost.goauthentik.io/sign_out">
              <LogOutIcon />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Sign out</TooltipContent>
      </Tooltip>
    </div>
  )
}
