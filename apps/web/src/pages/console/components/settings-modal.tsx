import { useState } from 'react'
import { MoonIcon, SunIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select'
import { Separator } from '@/shared/ui/separator'
import { ModelLogo } from '@/shared/components/model-logo'
import { ChatOnlyBadge } from '@/shared/components/chat-only-badge'
import { usePreferences } from '@/shared/hooks/use-preferences'
import type { Meta } from '@/shared/lib/types'

/**
 * Everything that configures the console, in one place.
 *
 * These lived as stacked sections in the sidebar, competing for space with the
 * agent list and the resources the agent can reach. Those are different kinds
 * of thing: resources answer "what can it see", settings answer "how is it set
 * up". Only the second belongs behind a gear.
 *
 * The model applies to the *next* agent, not the selected one — a run's model
 * is fixed once it starts.
 */
export function SettingsModal({
  open,
  onOpenChange,
  meta,
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
  modelId: string
  onModelChange: (id: string) => void
  agentCount: number
  onClearAll: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  const model = meta?.models.find((m) => m.id === modelId)
  const { language, setLanguage, showToolTrace, setShowToolTrace, t } = usePreferences()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings')}</DialogTitle>
          <DialogDescription>{t('settingsDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-4">
          <Field label={t('model')}>
            <Select value={modelId} onValueChange={onModelChange}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder={t('loading')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {meta?.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2">
                        <ModelLogo model={m} size={16} className="rounded-[4px]" />
                        <span className="readout">{m.label}</span>
                        {m.mode === 'chat-only' ? <ChatOnlyBadge /> : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {model?.mode === 'chat-only' ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('modelChatOnly')}
              </p>
            ) : model && !model.ready ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('modelNeedsKey')}
              </p>
            ) : null}
          </Field>
        </div>

        <Separator />

        <div className="px-5 py-4">
          <h2 className="label mb-3 text-muted-foreground">{t('display')}</h2>
          <div className="divide-y rounded-lg border">
            <PreferenceRow label={t('language')} description={t('languageDescription')}>
              <Select value={language} onValueChange={(value) => setLanguage(value === 'ms' ? 'ms' : 'en')}>
                <SelectTrigger className="h-8 min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">{t('english')}</SelectItem>
                  <SelectItem value="ms">{t('malay')}</SelectItem>
                </SelectContent>
              </Select>
            </PreferenceRow>

            <PreferenceRow label={t('toolTrace')} description={t('toolTraceDescription')}>
              <Select
                value={showToolTrace ? 'shown' : 'hidden'}
                onValueChange={(value) => setShowToolTrace(value === 'shown')}
              >
                <SelectTrigger className="h-8 min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hidden">{t('hidden')}</SelectItem>
                  <SelectItem value="shown">{t('shown')}</SelectItem>
                </SelectContent>
              </Select>
            </PreferenceRow>

            <PreferenceRow label={t('appearance')}>
              <Button variant="outline" size="sm" onClick={onToggleTheme} className="gap-1.5">
                {theme === 'dark' ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
                {theme === 'dark' ? t('light') : t('dark')}
              </Button>
            </PreferenceRow>
          </div>
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-5 py-3.5">
          <span className="min-w-0">
            <span className="label block text-muted-foreground">{t('agents')}</span>
            <span className="readout text-[0.6875rem] text-muted-foreground">
              {t('agentsStored', { count: agentCount })}
            </span>
          </span>
          {/* Destructive and irreversible — it deletes stored conversations, not
              just the board — so it sits apart from the settings above. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={agentCount === 0}
            className="ml-auto gap-1.5 text-destructive hover:text-destructive"
          >
            <Trash2Icon data-icon="inline-start" />
            {t('removeAll')}
          </Button>
        </div>
      </DialogContent>

      {/* Removes every agent and every stored transcript in this workspace —
          the most destructive button in the app, and previously the only one
          that fired on a single click. */}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t('removeAllTitle')}
        description={t('removeAllDescription', {
          count: agentCount,
          agents: t(agentCount === 1 ? 'agentSingular' : 'agentPlural'),
        })}
        confirmLabel={t('removeAll')}
        onConfirm={onClearAll}
      />
    </Dialog>
  )
}

function PreferenceRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4 px-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
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
