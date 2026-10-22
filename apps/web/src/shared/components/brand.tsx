import { cn } from '@/shared/lib/utils'

/**
 * The full ministry lockup, for places with room to read it: the sign-in
 * panel, onboarding, and the invitation header.
 *
 * The source is a white-background image, so it rides its own white card. That
 * also keeps the black ministry name legible on the dark sign-in panel, where
 * the old teal wordmark relied on a dark ground.
 */
export function Brand({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center overflow-hidden rounded-lg bg-white p-1.5 shadow-sm',
        className,
      )}
    >
      <img
        src={`${import.meta.env.BASE_URL}logos/pixelspace.png`}
        alt="Kementerian Sains, Teknologi dan Inovasi"
        className="h-full w-auto select-none object-contain"
        draggable={false}
      />
    </span>
  )
}

/**
 * The coat of arms on its own, for narrow identity slots: the sidebar, the
 * mobile header, and the empty console. The transparent PNG keeps the mark
 * clean on both themes, and its aspect ratio fits a rail.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}logos/logoonly.png`}
      alt="Kementerian Sains, Teknologi dan Inovasi"
      className={cn('w-auto select-none', className)}
      draggable={false}
    />
  )
}
