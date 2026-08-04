import { MoonIcon, SunIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ModelLogo } from '@/components/model-logo'
import type { Meta } from '@/lib/types'

/**
 * Everything that configures the console, in one place.
 *
 * These lived as stacked sections in the sidebar, competing for space with the
 * agent list and the resources the agent can reach. Those are different kinds
 * of thing: resources answer "what can it see", settings answer "how is it set
 * up". Only the second belongs behind a gear.
 *
 * Model and harness apply to the *next* agent, not the selected one — a run's
 * model is fixed once it starts.
 */
export function SettingsModal({
  open,
  onOpenChange,
  meta,
  harnessId,
  onHarnessChange,
  modelId,
  onModelChange,
  agentCount,
  onClearAll,
  theme,
  onToggleTheme,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meta: Meta | null
  harnessId: string
  onHarnessChange: (id: string) => void
  modelId: string
  onModelChange: (id: string) => void
  agentCount: number
  onClearAll: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  const model = meta?.models.find((m) => m.id === modelId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Applies to the next agent you start.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-4">
          <Field label="Model">
            <Select value={modelId} onValueChange={onModelChange}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {meta?.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2">
                        <ModelLogo model={m} size={16} className="rounded-[4px]" />
                        <span className="readout">{m.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {model && !model.ready ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Add an API key to use this model.
              </p>
            ) : null}
          </Field>

          <Field label="Harness">
            <Select value={harnessId} onValueChange={onHarnessChange}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {meta?.harnesses.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-5 py-3.5">
          <span className="label text-muted-foreground">Appearance</span>
          <Button variant="outline" size="sm" onClick={onToggleTheme} className="ml-auto gap-1.5">
            {theme === 'dark' ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-5 py-3.5">
          <span className="min-w-0">
            <span className="label block text-muted-foreground">Agents</span>
            <span className="readout text-[0.6875rem] text-muted-foreground">
              {agentCount} stored on this browser
            </span>
          </span>
          {/* Destructive and irreversible — it deletes stored conversations, not
              just the board — so it sits apart from the settings above. */}
          <Button
            variant="outline"
            size="sm"
            onClick={onClearAll}
            disabled={agentCount === 0}
            className="ml-auto gap-1.5 text-destructive hover:text-destructive"
          >
            <Trash2Icon data-icon="inline-start" />
            Remove all
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="label mb-1.5 text-muted-foreground">{label}</h2>
      {children}
    </div>
  )
}
