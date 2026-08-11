import { cn } from '@/lib/utils'

/**
 * The PixelSpace lockup.
 *
 * One component rather than three `<img>` tags, because the three places it
 * appears differ only in height — and a wordmark that drifts out of sync
 * between the sidebar and the mobile header is the kind of thing nobody
 * reports and everybody notices.
 *
 * Height-only sizing: the asset is 2100x393, and constraining width instead
 * would let a narrow container squash it. `w-auto` keeps the ratio and lets
 * flex measure it.
 *
 * The teal gradient is legible on both grounds, but its darker half sits close
 * to the dark theme's ground, so that theme gets a small lift rather than a
 * second asset to keep in sync.
 */
export function Brand({ className }: { className?: string }) {
  return (
    <img
      src="/logos/pixelspace.png"
      alt="PixelSpace"
      className={cn('w-auto select-none dark:brightness-115', className)}
      draggable={false}
    />
  )
}
