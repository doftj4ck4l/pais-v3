import { usePreferences } from '@/shared/hooks/use-preferences'

export function ChatOnlyBadge() {
  const { t } = usePreferences()
  return (
    <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[0.5625rem] leading-none text-muted-foreground">
      {t('chatOnly')}
    </span>
  )
}
