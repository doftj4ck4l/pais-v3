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
import { logoutLocalSession } from '@/shared/api/api'

/**
 * Who you are signed in as, and how to stop being them.
 *
 * Local mode revokes its server-side session before returning to the login
 * screen. Proxy mode hands the browser to the provider's own sign-out endpoint.
 */
export function UserMenu() {
  const me = useMe()
  const [profileOpen, setProfileOpen] = useState(false)

  if (!me) return null

  const label = me.name || me.username || me.id
  const secondary = me.email ?? (me.username && me.name ? me.username : null)
  const localSignOut = () => {
    void logoutLocalSession().finally(() => window.location.assign('/'))
  }

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
          {me.authMode === 'local' ? (
            <DropdownMenuItem onSelect={localSignOut}>
              <LogOutIcon className="size-4 text-muted-foreground" />
              Sign out
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem asChild>
              <a href="/outpost.goauthentik.io/sign_out">
                <LogOutIcon className="size-4 text-muted-foreground" />
                Sign out
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  )
}
