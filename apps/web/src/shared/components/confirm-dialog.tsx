import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Button } from '@/shared/ui/button'
import { usePreferences } from '@/shared/hooks/use-preferences'

/**
 * A last check before something irreversible.
 *
 * Built on the existing Dialog rather than pulling in a separate alert-dialog
 * primitive: the only behaviour an alert dialog adds here is trapping focus on
 * the safe action, which `autoFocus` on Cancel does directly.
 *
 * Deliberately not used for everything — a confirmation on a reversible action
 * is noise, and noise is what teaches people to click through the ones that
 * matter.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  onConfirm: () => void
}) {
  const { t } = usePreferences()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex justify-end gap-2">
          {/* Focused on open, so Enter dismisses rather than deletes. */}
          <Button variant="ghost" size="sm" autoFocus onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
