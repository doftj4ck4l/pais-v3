import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { TraceLine } from '@/lib/types'

export function TraceSheet({
  open,
  onOpenChange,
  trace,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trace: TraceLine[]
}) {
  const t0 = trace[0]?.ts ?? 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="text-base font-bold">Trace</SheetTitle>
          <SheetDescription className="text-xs">
            What the runtime did on the last run.
          </SheetDescription>
        </SheetHeader>

        {trace.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Nothing yet. Send the agent something and the steps land here.
          </p>
        ) : (
          <ol className="flex-1 overflow-y-auto px-4 py-4">
            {trace.map((line, i) => (
              <li key={i} className="border-l border-rail pb-3 pl-3 last:pb-0">
                <div className="flex items-baseline gap-2">
                  <span className="readout font-medium text-foreground">{line.step}</span>
                  <span className="readout text-[0.625rem] text-muted-foreground">
                    +{((line.ts - t0) / 1000).toFixed(2)}s
                  </span>
                </div>
                <p className="readout mt-1 break-all text-muted-foreground">
                  {Object.entries(line.fields)
                    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                    .join('  ')}
                </p>
              </li>
            ))}
          </ol>
        )}
      </SheetContent>
    </Sheet>
  )
}
