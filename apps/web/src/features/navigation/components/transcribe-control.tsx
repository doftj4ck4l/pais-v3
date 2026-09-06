import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, CheckIcon, MicIcon } from 'lucide-react'
import { Spinner } from '@/shared/ui/spinner'
import { transcribeAudio } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { cn } from '@/shared/lib/utils'

/**
 * The sidebar's own audio upload: pick a file, and it is transcribed and
 * indexed into Docs while the run list stays put.
 *
 * A compact row rather than a destination, because it is an action a chat
 * column naturally sits beside: the user is on Chats, remembers a recording,
 * uploads it, and the transcript is searchable the moment the row goes quiet.
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

  return (
    <div className="mx-1 mb-1 flex flex-col gap-1 rounded-lg border px-2.5 py-2">
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
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs text-muted-foreground',
          'transition-colors hover:bg-accent hover:text-foreground',
          'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60',
        )}
      >
        {busy ? (
          <Spinner className="size-3.5" />
        ) : (
          <MicIcon className="size-3.5" />
        )}
        <span className="min-w-0 truncate" title={t('transcribeAudioHint')}>
          {busy ? t('transcribingAudio', { name: status.title }) : t('transcribeAudio')}
        </span>
      </button>

      {status.kind === 'done' ? (
        <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={status.title}>
            {t('transcribedAudio', { title: status.title, chunks: status.chunks })}
          </span>
        </span>
      ) : status.kind === 'failed' ? (
        <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={status.error}>
            {status.error}
          </span>
        </span>
      ) : null}
    </div>
  )
}
