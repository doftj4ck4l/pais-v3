import { cn } from '@/shared/lib/utils'

export function OrganizationBadges({
  organizations,
  className,
  compact = false,
}: {
  organizations: Array<{ id: string; name: string }>
  className?: string
  compact?: boolean
}) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {organizations.length ? organizations.map((organization) => (
        <span key={organization.id} className={cn('rounded-md bg-muted px-2 text-xs', compact ? 'py-0.5' : 'py-1')}>
          {organization.name}
        </span>
      )) : (
        <span className={cn('rounded-md border border-dashed px-2 text-xs text-muted-foreground', compact ? 'py-0.5' : 'py-1')}>
          Independent
        </span>
      )}
    </div>
  )
}
