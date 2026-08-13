import { Link } from '@tanstack/react-router'
import { SettingsIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { NAV_ITEMS } from '@/features/navigation/lib/nav-items'
import { UserMenu } from '@/features/navigation/components/user-menu'
import { WorkspacePicker } from '@/features/navigation/components/workspace-picker'
import { cn } from '@/shared/lib/utils'

/**
 * Where everything is. One column of icons, always present, at every width.
 *
 * Icons only: seven destinations with labels is a second sidebar, and the
 * console already spends one on the agent list. Each icon names itself on
 * hover, and the page it opens says what it is in its own header — a label in
 * the rail would be the third copy.
 *
 * The settings gear sits at the foot rather than beside the workspace mark
 * because it is the one thing here that is not a place.
 */
export function NavRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <nav
      aria-label="Console"
      className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-3"
    >
      <WorkspacePicker />
      <span className="my-2 h-px w-6 bg-border" aria-hidden />

      {NAV_ITEMS.map((item) => (
        <Tooltip key={item.to}>
          <TooltipTrigger asChild>
            <Link
              to={item.to}
              // Without this every route matches `/`, so Chat would be lit on
              // every page.
              activeOptions={{ exact: item.to === '/' }}
              aria-label={item.label}
              className={cn(
                'flex size-9 items-center justify-center rounded-lg text-muted-foreground',
                'transition-colors hover:bg-accent hover:text-foreground',
                'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
              activeProps={{ className: 'bg-accent text-foreground' }}
            >
              <item.icon className="size-[1.05rem]" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span className="font-medium">{item.label}</span>
            <span className="ml-1.5 text-muted-foreground">{item.hint}</span>
          </TooltipContent>
        </Tooltip>
      ))}

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className={cn(
              'flex size-9 items-center justify-center rounded-lg text-muted-foreground',
              'transition-colors hover:bg-accent hover:text-foreground',
              'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
          >
            <SettingsIcon className="size-[1.05rem]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>

      <div className="mt-1">
        <UserMenu />
      </div>
    </nav>
  )
}
