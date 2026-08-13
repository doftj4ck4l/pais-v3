import { useState } from 'react'
import { LogOutIcon, UserIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { ProfileDialog } from '@/features/workspace/components/profile-dialog'
import { useMe } from '@/features/workspace/hooks/use-me'

/**
 * Who you are signed in as, and how to stop being them.
 *
 * The console has no login of its own — authentication happens at the proxy —
 * so without this there is no way to tell an authenticated session from an open
 * door except by leaving the app and asking the identity provider.
 *
 * Sign-out is a plain link rather than a fetch: it hands the browser to the
 * proxy's own endpoint, which clears the session cookie and redirects. Doing it
 * over XHR would clear the cookie while leaving a stale console on screen.
 */
export function UserMenu() {
  const me = useMe()
  const [profileOpen, setProfileOpen] = useState(false)

  if (!me) return null

  const label = me.name || me.username || me.id
  const secondary = me.email ?? (me.username && me.name ? me.username : null)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Signed in as ${label}`}
          className="flex size-8 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-semibold uppercase text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {label.slice(0, 2)}
        </DropdownMenuTrigger>

        <DropdownMenuContent side="right" align="end">
          <div className="px-2 py-1.5 leading-tight">
            <p className="truncate text-sm font-medium">{label}</p>
            {secondary ? (
              <p className="truncate text-xs text-muted-foreground">{secondary}</p>
            ) : null}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
            <UserIcon className="size-4 text-muted-foreground" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="/outpost.goauthentik.io/sign_out">
              <LogOutIcon className="size-4 text-muted-foreground" />
              Sign out
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  )
}
