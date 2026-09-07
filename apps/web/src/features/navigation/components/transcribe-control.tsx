import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, CheckIcon, MicIcon } from 'lucide-react'
import { Spinner } from '@/shared/ui/spinner'
import { transcribeAudio } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { cn } from '@/shared/lib/utils'

/**
 * The rail's own audio upload: pick a file, and it is transcribed and indexed
 * into Docs while the run list stays put.
 *
 * An icon on the rail rather than a row in the chat column, so the action is
 * reachable from any page and never crowds the sessions list. The same upload
 * logic as before; the button just wears the rail's uniform. While a file is
 * transcribing the icon becomes a spinner; when the transcript is indexed the
 * icon briefly turns into a check so the quiet state does not look like a fail.
 */
type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; title: string }
  | { kind: 'done'; title: string; chunks: number }
  | { kind: 'failed'; title: string; error: string }

const CLEAR_AFTER_MS = 8_000

export function TranscribeControl() {
  const scope = useScope()
  const { t } = usePreferences()
  const inputRef = useRef<HTMLInputElement>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const clearSoon = useCallback(() => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
    clearTimer.current = setTimeout(() => setStatus({ kind: 'idle' }), CLEAR_AFTER_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
    }
  }, [])

  const upload = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      setStatus({ kind: 'busy', title: file.name })
      try {
        const result = await transcribeAudio(scope, file)
        if (result.status === 'indexed') {
          setStatus({ kind: 'done', title: result.title, chunks: result.chunks })
        } else {
          setStatus({
            kind: 'failed',
            title: result.title,
            error: result.error ?? t('audioEmpty'),
          })
        }
      } catch (e) {
        setStatus({ kind: 'failed', title: file.name, error: e instanceof Error ? e.message : String(e) })
      }
      clearSoon()
    },
    [clearSoon, scope, t],
  )

  const busy = status.kind === 'busy'

  // The label rides the tooltip, and the icon state a screen reader hears.
  const label =
    status.kind === 'busy'
      ? t('transcribingAudio', { name: status.title })
      : status.kind === 'done'
        ? t('transcribedAudio', { title: status.title, chunks: status.chunks })
        : status.kind === 'failed'
          ? status.error
          : t('transcribeAudioHint')

  const done = status.kind === 'done'
  const failed = status.kind === 'failed'

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,audio/mpeg,audio/wav,.mp3,.wav,.m4a,.ogg,.flac,.opus,.aac"
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files?.[0])
          e.target.value = '' // let the same file be transcribed again
        }}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            aria-label={label}
            className={cn(
              'flex size-9 items-center justify-center rounded-lg text-muted-foreground',
              'transition-colors hover:bg-accent hover:text-foreground',
              'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60',
              done && 'text-emerald-500',
              failed && 'text-red-500',
            )}
          >
            {busy ? (
              <Spinner className="size-[1.125rem]" />
            ) : done ? (
              <CheckIcon className="size-[1.125rem]" />
            ) : failed ? (
              <AlertTriangleIcon className="size-[1.125rem]" />
            ) : (
              <MicIcon className="size-[1.125rem]" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </>
  )
}
