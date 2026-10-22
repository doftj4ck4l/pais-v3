import { cn } from '@/shared/lib/utils'
import type { Model } from '@/shared/lib/types'

/** `png` is the default, so only the brands whose asset is not one appear here. */
const BRAND_EXT: Record<string, string> = {
  qwen: 'jpg',
  deepseek: 'svg',
  nvidia: 'svg',
  muse: 'svg',
  vrs: 'svg',
}

export function modelLogoUrl(model?: Model | null): string | null {
  if (!model?.brand) return null
  const ext = BRAND_EXT[model.brand] ?? 'png'
  return `${import.meta.env.BASE_URL}logos/${model.brand}.${ext}`
}

/**
 * A brand logo mark for a model. Renders the real brand logo as an image when
 * available, falling back to a colored monogram of the brand name.
 */
export function ModelLogo({
  model,
  size = 28,
  className,
}: {
  model?: Model | null
  size?: number
  className?: string
}) {
  const url = modelLogoUrl(model)
  const initial = (model?.label ?? '?')[0]?.toUpperCase() ?? '?'

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-card',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {url ? (
        <img
          src={url}
          alt={model?.brand ?? 'model'}
          className="h-full w-full object-contain p-0.5"
        />
      ) : (
        <span className="readout text-sm font-bold text-muted-foreground">{initial}</span>
      )}
    </span>
  )
}
