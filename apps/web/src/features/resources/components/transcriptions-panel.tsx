import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  FileTextIcon,
  MicIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import {
  ItemCard,
  PanelEmpty,
  PanelGrid,
  PanelHeader,
} from '@/features/resources/components/panel-kit'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  deleteTranscription,
  enqueueTranscription,
  fetchTranscript,
  listTranscriptions,
  transcriptDownloadUrl,
} from '@/shared/api/api'
import { recentlyFinished } from '@/features/resources/lib/transcriptions'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import type { TranscriptionRow, TranscriptionStatus } from '@/shared/lib/types'
import type { TranslationKey } from '@/shared/lib/i18n'
import { cn } from '@/shared/lib/utils'

/**
 * Audio this workspace is transcribing, and where the queue lives.
 *
 * Uploading went from blocking (the request held open for the whole whisper
 * call) to a queue: the job appears here as a tile the moment it is recorded,
 * and the page polls until every one of them settles. "Done" is reported here
 * too — a job that flipped while the page was open gets a banner, because a
 * session that started a transcription deserves to notice the result, not go
 * hunting for it.
 */
const POLL_MS = 2_000
const BANNER_MS = 8_000
const ACCEPT = 'audio/*,audio/mpeg,audio/wav,.mp3,.wav,.m4a,.ogg,.flac,.opus,.aac'

const isAudioFile = (f: File) =>
  f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|opus|aac|mp4)$/i.test(f.name)

export function TranscriptionsPanel() {
  const scope = useScope()
  const { t } = usePreferences()
  const [rows, setRows] = useState<TranscriptionRow[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** Titles of jobs that finished while this page was open. */
  const [justFinished, setJustFinished] = useState<string[]>([])
  /** The finished job whose transcript is being read. */
  const [viewing, setViewing] = useState<TranscriptionRow | null>(null)
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previousRef = useRef<TranscriptionRow[]>([])

  const refresh = useCallback(async () => {
    try {
      const next = await listTranscriptions(scope)
      const finished = recentlyFinished(previousRef.current, next)
      if (finished.length) {
        setJustFinished((prev) => [...finished.map((r) => r.title), ...prev].slice(0, 5))
        if (bannerTimer.current) clearTimeout(bannerTimer.current)
        bannerTimer.current = setTimeout(() => setJustFinished([]), BANNER_MS)
      }
      previousRef.current = next
      setRows(next)
    } catch {
      // A listing is the page's whole job, but a transient failure is not
      // worth dropping what is already shown.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
    return () => {
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
    }
  }, [refresh])

  // Keep polling while anything is unresolved; the interval skipping hidden
  // tabs plus a refresh on focus covers the user turning away and back.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)
    const wake = () => void refresh()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [refresh])

  const upload = useCallback(
    async (files: File[]) => {
      const audio = files.filter(isAudioFile)
      if (!audio.length) return
      setBusy(true)
      setUploadError(null)
      try {
        for (const file of audio) {
          try {
            await enqueueTranscription(scope, file)
          } catch (e) {
            setUploadError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } finally {
        setBusy(false)
      }
      await refresh()
    },
    [refresh, scope],
  )

  const remove = useCallback(
    (id: string) => {
      setRows((prev) => prev.filter((r) => r.id !== id)) // optimistic
      void deleteTranscription(scope, id).then(refresh)
    },
    [refresh, scope],
  )

  const ready = rows.filter((r) => r.status === 'done').length
  const inputId = 'transcriptions-audio-input'

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg transition-colors',
        dragging && 'outline-2 outline-offset-8 outline-dashed outline-foreground/30',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void upload(Array.from(e.dataTransfer.files))
      }}
    >
      <PanelHeader
        busy={busy}
        summary={
          rows.length
            ? t('transcriptionsSummary', {
                total: rows.length,
                transcriptions: t(rows.length === 1 ? 'transcriptionSingular' : 'transcriptionPlural'),
                ready,
              })
            : null
        }
        action={
          rows.length ? (
            <label htmlFor={inputId}>
              <Button size="sm" asChild>
                <span>
                  <UploadIcon data-icon="inline-start" />
                  {t('transcribeAudio')}
                </span>
              </Button>
            </label>
          ) : null
        }
      />

      {justFinished.length ? (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        >
          <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-muted-foreground">
            {t('transcriptionReadyBanner', {
              count: justFinished.length,
              transcriptions: t(
                justFinished.length === 1 ? 'transcriptionSingular' : 'transcriptionPlural',
              ),
            })}
          </span>
          <button
            type="button"
            onClick={() => setJustFinished([])}
            aria-label={t('dismiss')}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      ) : null}

      {uploadError ? <p className="mb-3 text-sm text-destructive">{uploadError}</p> : null}

      <input
        id={inputId}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []))
          e.target.value = '' // let the same file be re-queued after it finishes
        }}
      />

      {rows.length ? (
        <PanelGrid>
          {rows.map((row) => (
            <TranscriptionItem
              key={row.id}
              row={row}
              onView={row.status === 'done' ? () => setViewing(row) : undefined}
              onRemove={() => remove(row.id)}
            />
          ))}
        </PanelGrid>
      ) : (
        <PanelEmpty
          icon={MicIcon}
          title={t('noTranscriptions')}
          description={t('noTranscriptionsDescription')}
          action={
            <label htmlFor={inputId}>
              <Button size="sm" asChild>
                <span>
                  <UploadIcon data-icon="inline-start" />
                  {t('transcribeAudio')}
                </span>
              </Button>
            </label>
          }
        />
      )}

      {viewing ? <TranscriptDialog row={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

function TranscriptionItem({
  row,
  onView,
  onRemove,
}: {
  row: TranscriptionRow
  onView?: () => void
  onRemove: () => void
}) {
  const { t } = usePreferences()
  const failed = row.status === 'failed'

  const leading =
    row.status === 'transcribing' ? (
      <Spinner className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    ) : failed ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{row.error ?? row.status}</TooltipContent>
      </Tooltip>
    ) : row.status === 'done' ? (
      <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    ) : (
      <ClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    )

  return (
    <ItemCard
      leading={leading}
      title={<span className={cn(failed && 'text-muted-foreground')}>{row.title}</span>}
      meta={`${statusLabel(t, row.status)} · ${formatBytes(row.bytes)}`}
      actions={
        <>
          {onView ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onView}
              aria-label={t('viewTranscript')}
              className="text-muted-foreground"
            >
              <FileTextIcon />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label={t('removeTranscription', { name: row.title })}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon />
          </Button>
        </>
      }
    />
  )
}

/**
 * The transcript of one finished job: read it here, or grab it as a `.txt`
 * file. The Docs page holds the same words as a searchable document; this is
 * the original, timestamped, exactly as the job stored it.
 */
function TranscriptDialog({ row, onClose }: { row: TranscriptionRow; onClose: () => void }) {
  const scope = useScope()
  const { t } = usePreferences()
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setText(null)
    setFailed(false)
    fetchTranscript(scope, row.id)
      .then(setText)
      .catch(() => setFailed(true))
  }, [row.id, scope])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('viewTranscript')}</DialogTitle>
          <DialogDescription className="truncate">{row.title}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
          {text ??
            (failed ? (
              <p className="text-destructive">{t('transcriptionFailed')}</p>
            ) : (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-3.5" />
                {t('loading')}
              </span>
            ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('statusDone')}
          </Button>
          <Button size="sm" asChild>
            <a href={transcriptDownloadUrl(scope, row.id)} download>
              <DownloadIcon data-icon="inline-start" />
              {t('downloadTranscript')}
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function statusLabel(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  status: TranscriptionStatus,
): string {
  switch (status) {
    case 'queued':
      return t('transcriptionQueued')
    case 'transcribing':
      return t('transcriptionTranscribing')
    case 'done':
      return t('transcriptionDone')
    case 'failed':
      return t('transcriptionFailed')
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit += 1
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[unit]}`
}
