import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, CheckIcon, MicIcon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Spinner } from '@/shared/ui/spinner'
import { enqueueTranscription } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { cn } from '@/shared/lib/utils'

/**
 * The rail's audio upload: pick a file, and it joins the transcription queue,
 * whose progress lives on the Transcriptions page.
 *
 * An icon on the rail rather than a row in the chat column, so the action is
 * reachable from any page and never crowds the sessions list. Uploading is the
 * fast part now — the server answers the moment the job is queued — so the icon
 * briefly shows a check, and the view hops to the Transcriptions page where the
 * tile flips queued → transcribing → done. Without that hop, "where's my
 * transcript" has no answer on a rail that is icons only.
 */
type Status =
  | { kind: 'idle' }
  | { kind: 'queuing'; title: string }
  | { kind: 'queued'; title: string }
  | { kind: 'failed'; title: string; error: string }

const CLEAR_AFTER_MS = 8_000

export function TranscribeControl() {
  const scope = useScope()
  const { t } = usePreferences()
  const navigate = useNavigate()
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
      setStatus({ kind: 'queuing', title: file.name })
      try {
        await enqueueTranscription(scope, file)
        setStatus({ kind: 'queued', title: file.name })
        // The page is where the wait is visible; the rail has no room to say so.
        void navigate({ to: '/transcriptions' })
      } catch (e) {
        setStatus({ kind: 'failed', title: file.name, error: e instanceof Error ? e.message : String(e) })
      }
      clearSoon()
    },
    [clearSoon, navigate, scope],
  )

  const busy = status.kind === 'queuing'

  // The label rides the tooltip, and the icon state a screen reader hears.
  const label =
    status.kind === 'queuing'
      ? t('transcribingAudio', { name: status.title })
      : status.kind === 'queued'
        ? t('queuedAudio', { name: status.title })
        : status.kind === 'failed'
          ? status.error
          : t('transcribeAudioHint')

  const queued = status.kind === 'queued'
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
              queued && 'text-emerald-500',
              failed && 'text-red-500',
            )}
          >
            {busy ? (
              <Spinner className="size-[1.125rem]" />
            ) : queued ? (
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
