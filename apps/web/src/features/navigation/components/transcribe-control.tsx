import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, CheckIcon, MicIcon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Spinner } from '@/shared/ui/spinner'
import { enqueueTranscription } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { cn } from '@/shared/lib/utils'

/**
 * The sidebar's audio upload: pick a file, and it joins the transcription queue,
 * whose progress lives on the Transcriptions page.
 *
 * It is a labelled action beside the destinations, so it is reachable from any
 * page without pretending to be a destination of its own. Uploading is the
 * fast part now — the server answers the moment the job is queued — and the
 * view then hops to Transcriptions where progress remains visible.
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
        // The page is where the full queued → transcribing → indexing → done state lives.
        void navigate({ to: '/transcriptions' })
      } catch (e) {
        setStatus({ kind: 'failed', title: file.name, error: e instanceof Error ? e.message : String(e) })
      }
      clearSoon()
    },
    [clearSoon, navigate, scope],
  )

  const busy = status.kind === 'queuing'

  // The row keeps its stable action name while the accessible label carries
  // the selected file and exact progress state.
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
  const visibleLabel = status.kind === 'queuing'
    ? t('transcribingAudio', { name: status.title })
    : status.kind === 'queued'
      ? t('queuedAudio', { name: status.title })
      : t('transcribeAudio')

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

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label={label}
        className={cn(
          'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-sidebar-foreground',
          'transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/30 focus-visible:outline-none disabled:opacity-60',
          queued && 'text-emerald-600 dark:text-emerald-400',
          failed && 'text-destructive',
        )}
      >
        {busy ? (
          <Spinner className="size-[1.125rem] shrink-0" />
        ) : queued ? (
          <CheckIcon className="size-[1.125rem] shrink-0" />
        ) : failed ? (
          <AlertTriangleIcon className="size-[1.125rem] shrink-0" />
        ) : (
          <MicIcon className="size-[1.125rem] shrink-0" strokeWidth={1.8} />
        )}
        <span className="truncate">{visibleLabel}</span>
      </button>
    </>
  )
}
