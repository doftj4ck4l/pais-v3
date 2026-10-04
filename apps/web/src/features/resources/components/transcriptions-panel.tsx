import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  Clock3Icon,
  CopyIcon,
  DownloadIcon,
  FileAudioIcon,
  FolderIcon,
  FolderOpenIcon,
  MicIcon,
  PencilLineIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { PanelEmpty } from '@/features/resources/components/panel-kit'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import {
  deleteTranscription,
  enqueueTranscription,
  getTranscription,
  listTranscriptions,
  transcriptionAudioUrl,
  transcriptDownloadUrl,
  updateTranscription,
  type TranscriptDownloadFormat,
} from '@/shared/api/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import {
  groupTranscriptionsByDate,
  hasActiveJobs,
  activeTranscriptSegment,
  transcriptTimestamp,
  transcriptionProgress,
} from '@/features/resources/lib/transcriptions'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { localeFor } from '@/shared/lib/i18n'
import type {
  TranscriptionDetail,
  TranscriptionRow,
  TranscriptionSegment,
  TranscriptionStatus,
} from '@/shared/lib/types'
import type { TranslationKey } from '@/shared/lib/i18n'
import { cn } from '@/shared/lib/utils'

const ACTIVE_POLL_MS = 1_000
const IDLE_POLL_MS = 8_000
const ACCEPT = 'audio/*,audio/mpeg,audio/wav,.mp3,.wav,.m4a,.ogg,.flac,.opus,.aac'

type LocalUpload = {
  key: string
  title: string
  status: 'uploading' | 'failed'
  progress: number
  error?: string
}

const isAudioFile = (file: File) =>
  file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|opus|aac|mp4)$/i.test(file.name)

export function TranscriptionsPanel() {
  const scope = useScope()
  const { language, t } = usePreferences()
  const [rows, setRows] = useState<TranscriptionRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<TranscriptionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [localUploads, setLocalUploads] = useState<LocalUpload[]>([])
  const [trackedIds, setTrackedIds] = useState<string[]>([])
  const [progressOpen, setProgressOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TranscriptionRow | null>(null)
  const knownActive = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    try {
      setRows(await listTranscriptions(scope))
    } catch {
      // Preserve the last useful browser state through a transient poll failure.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const active = hasActiveJobs(rows) || localUploads.some((upload) => upload.status === 'uploading')

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, active ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    const wake = () => void refresh()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [active, refresh])

  // Jobs started from the persistent sidebar arrive before this page mounts.
  // Discover each id once so the live sheet opens once, but stays dismissible.
  useEffect(() => {
    const discovered = rows
      .filter((row) => isActive(row.status) && !knownActive.current.has(row.id))
      .map((row) => row.id)
    if (!discovered.length) return
    discovered.forEach((id) => knownActive.current.add(id))
    setTrackedIds((current) => [...new Set([...current, ...discovered])])
    setProgressOpen(true)
  }, [rows])

  const folders = useMemo(
    () => groupTranscriptionsByDate(rows, {
      locale: localeFor(language),
      today: t('today'),
      yesterday: t('yesterday'),
    }),
    [language, rows, t],
  )

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(localeFor(language))
    return folders
      .filter((folder) => selectedFolder === 'all' || folder.key === selectedFolder)
      .map((folder) => ({
        ...folder,
        rows: folder.rows.filter((row) => row.title.toLocaleLowerCase(localeFor(language)).includes(needle)),
      }))
      .filter((folder) => folder.rows.length)
  }, [folders, language, query, selectedFolder])

  const visibleRows = useMemo(() => visibleGroups.flatMap((folder) => folder.rows), [visibleGroups])
  const selected = rows.find((row) => row.id === selectedId) ?? null
  const detailId = selected?.status === 'done' ? selected.id : null

  useEffect(() => {
    if (visibleRows.length && !visibleRows.some((row) => row.id === selectedId)) {
      setSelectedId(visibleRows[0]!.id)
    } else if (!visibleRows.length) {
      setSelectedId(null)
    }
  }, [selectedId, visibleRows])

  useEffect(() => {
    setCopied(false)
    setEditorOpen(false)
    if (!detailId) {
      setDetail(null)
      setDetailLoading(false)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    void getTranscription(scope, detailId)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => { cancelled = true }
  }, [detailId, scope])

  const upload = useCallback(async (files: File[]) => {
    const audio = files.filter(isAudioFile)
    if (!audio.length) return

    const incoming = audio.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      title: file.name,
      status: 'uploading' as const,
      progress: 0,
    }))
    setLocalUploads((current) => [
      ...current.filter((upload) => upload.status === 'uploading'),
      ...incoming,
    ])
    setTrackedIds(rows.filter((row) => isActive(row.status)).map((row) => row.id))
    setUploadError(null)
    setProgressOpen(true)

    for (const [index, file] of audio.entries()) {
      const local = incoming[index]!
      try {
        const result = await enqueueTranscription(scope, file, (progress) => {
          setLocalUploads((current) => current.map((upload) =>
            upload.key === local.key ? { ...upload, progress } : upload,
          ))
        })
        knownActive.current.add(result.transcriptionId)
        setTrackedIds((current) => [...new Set([...current, result.transcriptionId])])
        setLocalUploads((current) => current.filter((upload) => upload.key !== local.key))
        await refresh()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setLocalUploads((current) => current.map((upload) =>
          upload.key === local.key ? { ...upload, status: 'failed', error: message } : upload,
        ))
        setUploadError(`${file.name}: ${message}`)
      }
    }
  }, [refresh, rows, scope])

  const remove = useCallback(async (row: TranscriptionRow) => {
    setRows((current) => current.filter((item) => item.id !== row.id))
    setPendingDelete(null)
    if (selectedId === row.id) setSelectedId(null)
    try {
      await deleteTranscription(scope, row.id)
    } finally {
      await refresh()
    }
  }, [refresh, scope, selectedId])

  const inputId = 'transcriptions-audio-input'
  const trackedRows = trackedIds
    .map((id) => rows.find((row) => row.id === id))
    .filter((row): row is TranscriptionRow => Boolean(row))

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden bg-background',
        dragging && 'ring-2 ring-inset ring-blue-500/50',
      )}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void upload(Array.from(event.dataTransfer.files))
      }}
    >
      <input
        id={inputId}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />

      <BrowserToolbar
        query={query}
        onQueryChange={setQuery}
        active={active}
        onShowProgress={() => setProgressOpen(true)}
        inputId={inputId}
      />

      {uploadError ? (
        <div role="alert" className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {uploadError}
        </div>
      ) : null}

      {rows.length ? (
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-y-auto lg:grid-cols-[13rem_minmax(20rem,0.9fr)_minmax(22rem,1.15fr)] lg:overflow-hidden">
          <FolderRail
            folders={folders}
            selected={selectedFolder}
            onSelect={setSelectedFolder}
          />
          <RecordingList
            groups={visibleGroups}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={setPendingDelete}
            empty={query ? t('noMatchingRecordings') : t('noTranscriptions')}
          />
          <TranscriptPreview
            row={selected}
            detail={detail}
            loading={detailLoading}
            copied={copied}
            downloadUrl={selected ? (format) => transcriptDownloadUrl(scope, selected.id, format) : null}
            audioUrl={selected?.hasAudio ? transcriptionAudioUrl(scope, selected.id) : null}
            onCopy={() => {
              if (!detail?.content) return
              void navigator.clipboard.writeText(detail.content).then(() => setCopied(true))
            }}
            onEdit={() => setEditorOpen(true)}
          />
        </div>
      ) : (
        <PanelEmpty
          icon={MicIcon}
          title={t('noTranscriptions')}
          description={t('noTranscriptionsDescription')}
          className="min-h-0 flex-1 border-t"
          action={(
            <label htmlFor={inputId}>
              <Button size="sm" asChild>
                <span><UploadIcon data-icon="inline-start" />{t('transcribeAudio')}</span>
              </Button>
            </label>
          )}
        />
      )}

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-blue-500/50 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderOpenIcon className="size-10 fill-blue-500/15 text-blue-500" />
            <p className="text-sm font-medium">{t('transcribeAudio')}</p>
          </div>
        </div>
      ) : null}

      <ProgressDialog
        open={progressOpen}
        onOpenChange={setProgressOpen}
        uploads={localUploads}
        rows={trackedRows}
        onShow={(id) => {
          setSelectedFolder('all')
          setQuery('')
          setSelectedId(id)
          setProgressOpen(false)
        }}
      />

      <TranscriptEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        row={selected}
        detail={detail}
        audioUrl={selected?.hasAudio ? transcriptionAudioUrl(scope, selected.id) : null}
        onSave={async (segments) => {
          if (!selected) throw new Error(t('transcriptSaveFailed'))
          const updated = await updateTranscription(scope, selected.id, segments)
          setDetail(updated)
          setRows((current) => current.map((row) => row.id === selected.id
            ? { ...row, updatedAt: updated.transcription.updatedAt }
            : row))
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={pendingDelete ? t('removeTranscription', { name: pendingDelete.title }) : t('remove')}
        description={t('removeTranscriptionDescription', { name: pendingDelete?.title ?? '' })}
        confirmLabel={t('remove')}
        onConfirm={() => pendingDelete ? void remove(pendingDelete) : undefined}
      />
    </div>
  )
}

function BrowserToolbar({
  query,
  onQueryChange,
  active,
  onShowProgress,
  inputId,
}: {
  query: string
  onQueryChange: (value: string) => void
  active: boolean
  onShowProgress: () => void
  inputId: string
}) {
  const { t } = usePreferences()
  return (
    <header className="flex min-h-14 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2 sm:gap-3 sm:px-4">
      <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-sm font-medium sm:w-auto">
        <FolderOpenIcon className="size-4 fill-blue-500/15 text-blue-500" />
        <span>{t('transcriptions')}</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate text-muted-foreground">{t('allRecordings')}</span>
      </div>
      <div className="flex w-full min-w-0 items-center justify-end gap-2 sm:ml-auto sm:w-auto">
        {active ? (
          <button
            type="button"
            onClick={onShowProgress}
            aria-label={t('workingInBackground')}
            className="flex h-8 items-center gap-2 rounded-lg bg-blue-500/10 px-2.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-500/15 dark:text-blue-400"
          >
            <Spinner className="size-3.5" />
            <span className="hidden sm:inline">{t('workingInBackground')}</span>
          </button>
        ) : null}
        <label className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('searchRecordings')}
            aria-label={t('searchRecordings')}
            className="h-8 w-full rounded-lg border bg-background pr-3 pl-8 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-blue-500/25"
          />
        </label>
        <Button
          size="sm"
          onClick={() => document.getElementById(inputId)?.click()}
          aria-label={t('transcribeAudio')}
        >
          <UploadIcon data-icon="inline-start" />
          <span className="hidden sm:inline">{t('transcribeAudio')}</span>
        </Button>
      </div>
    </header>
  )
}

function FolderRail({
  folders,
  selected,
  onSelect,
}: {
  folders: ReturnType<typeof groupTranscriptionsByDate>
  selected: string
  onSelect: (key: string) => void
}) {
  const { t } = usePreferences()
  const items = [{ key: 'all', label: t('allRecordings'), count: folders.reduce((n, folder) => n + folder.rows.length, 0) },
    ...folders.map((folder) => ({ key: folder.key, label: folder.label, count: folder.rows.length }))]

  return (
    <aside className="border-b bg-muted/25 p-2 lg:border-r lg:border-b-0" aria-label={t('recordingFolders')}>
      <p className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t('recordingFolders')}
      </p>
      <div className="scrollbar-subtle flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {items.map((item) => {
          const active = selected === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSelect(item.key)}
              className={cn(
                'flex h-9 min-w-fit items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors lg:w-full',
                active ? 'bg-blue-500 text-white shadow-sm' : 'hover:bg-foreground/5',
              )}
            >
              {item.key === 'all' ? (
                <FolderOpenIcon className="size-4 shrink-0" />
              ) : (
                <FolderIcon className={cn('size-4 shrink-0', !active && 'fill-blue-500/15 text-blue-500')} />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className={cn('readout text-[10px]', active ? 'text-white/75' : 'text-muted-foreground')}>
                {item.count}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function RecordingList({
  groups,
  selectedId,
  onSelect,
  onRemove,
  empty,
}: {
  groups: ReturnType<typeof groupTranscriptionsByDate>
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (row: TranscriptionRow) => void
  empty: string
}) {
  const { language, t } = usePreferences()
  if (!groups.length) {
    return <div className="flex min-h-48 items-center justify-center border-b px-6 text-center text-sm text-muted-foreground lg:border-r lg:border-b-0">{empty}</div>
  }

  return (
    <section className="min-h-0 min-w-0 overflow-y-auto border-b lg:border-r lg:border-b-0" aria-label={t('allRecordings')}>
      <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_6.5rem_5rem] border-b bg-card/95 px-3 py-2 text-[11px] font-medium text-muted-foreground backdrop-blur-sm sm:grid">
        <span>{t('name')}</span><span>{t('modified')}</span><span>{t('size')}</span>
      </div>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="sticky top-0 z-[5] flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground backdrop-blur-sm sm:top-[33px]">
            <FolderIcon className="size-3.5 fill-blue-500/15 text-blue-500" />
            <span>{group.label}</span>
            <span className="font-normal">{group.rows.length}</span>
          </div>
          <ul>
            {group.rows.map((row) => {
              const active = row.id === selectedId
              return (
                <li key={row.id} className={cn('group relative border-b last:border-b-0', active && 'bg-blue-500 text-white')}>
                  <button
                    type="button"
                    onClick={() => onSelect(row.id)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300 sm:grid-cols-[minmax(0,1fr)_6.5rem_5rem]"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FileAudioIcon className={cn('size-4 shrink-0', active ? 'text-white' : 'text-blue-500')} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{row.title}</span>
                        <span className={cn('mt-0.5 block text-[11px] sm:hidden', active ? 'text-white/75' : 'text-muted-foreground')}>
                          {statusLabel(t, row.status)} · {formatBytes(row.bytes)}
                        </span>
                      </span>
                    </span>
                    <span className={cn('readout hidden text-[11px] sm:block', active ? 'text-white/75' : 'text-muted-foreground')}>
                      {new Intl.DateTimeFormat(localeFor(language), { hour: '2-digit', minute: '2-digit' }).format(row.updatedAt)}
                    </span>
                    <span className={cn('readout hidden text-[11px] sm:block', active ? 'text-white/75' : 'text-muted-foreground')}>
                      {formatBytes(row.bytes)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(row)}
                    aria-label={t('removeTranscription', { name: row.title })}
                    className={cn(
                      'absolute top-1/2 right-2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 sm:right-1',
                      active ? 'hover:bg-white/15' : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                    )}
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}

function TranscriptPreview({
  row,
  detail,
  loading,
  copied,
  downloadUrl,
  audioUrl,
  onCopy,
  onEdit,
}: {
  row: TranscriptionRow | null
  detail: TranscriptionDetail | null
  loading: boolean
  copied: boolean
  downloadUrl: ((format: TranscriptDownloadFormat) => string) | null
  audioUrl: string | null
  onCopy: () => void
  onEdit: () => void
}) {
  const { language, t } = usePreferences()
  if (!row) {
    return (
      <section className="flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <FileAudioIcon className="size-8 stroke-[1.4]" />
        <p className="max-w-xs text-sm leading-relaxed">{t('selectRecording')}</p>
      </section>
    )
  }

  const content = detail?.transcription.id === row.id ? detail.content : null
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background" aria-label={t('transcriptPreview')}>
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
          <FileAudioIcon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{row.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {statusLabel(t, row.status)} · {new Intl.DateTimeFormat(localeFor(language), {
              dateStyle: 'medium', timeStyle: 'short',
            }).format(row.createdAt)}
          </p>
        </div>
        {content ? (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={t('editTranscript')}>
              <PencilLineIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onCopy} aria-label={t('copyTranscript')}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('downloadTranscript')}>
                  <DownloadIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(['pdf', 'docx', 'txt'] as const).map((format) => (
                  <DropdownMenuItem key={format} asChild>
                    <a href={downloadUrl?.(format)} download>
                      {format.toUpperCase()}
                    </a>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full min-h-64 items-center justify-center"><Spinner className="size-5 text-muted-foreground" /></div>
        ) : content ? (
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-5 py-5">
            <TranscriptPlayer
              segments={detail?.segments ?? []}
              audioUrl={audioUrl}
              label={row.title}
            />
          </div>
        ) : row.status === 'failed' ? (
          <PreviewMessage icon={AlertTriangleIcon} title={t('transcriptionFailed')} description={row.error ?? t('transcriptNotReady')} destructive />
        ) : row.status === 'done' ? (
          <PreviewMessage icon={AlertTriangleIcon} title={t('transcriptUnavailable')} description={t('transcriptUnavailableDescription')} />
        ) : (
          <PreviewMessage
            icon={isActive(row.status) ? Spinner : Clock3Icon}
            title={stageTitle(t, row.status)}
            description={stageDescription(t, row.status)}
            progress={transcriptionProgress(row.status)}
          />
        )}
      </div>

      <footer className="grid grid-cols-2 gap-3 border-t bg-muted/20 px-4 py-3 text-xs sm:grid-cols-3">
        <Metadata label={t('size')} value={formatBytes(row.bytes)} />
        <Metadata label={t('model')} value={row.model ?? '—'} />
        <Metadata label={t('status')} value={statusLabel(t, row.status)} />
      </footer>
    </section>
  )
}

function TranscriptPlayer({
  segments,
  audioUrl,
  label,
  editable = false,
  onChange,
}: {
  segments: TranscriptionSegment[]
  audioUrl: string | null
  label: string
  editable?: boolean
  onChange?: (segments: TranscriptionSegment[]) => void
}) {
  const { t } = usePreferences()
  const audioRef = useRef<HTMLAudioElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [audioError, setAudioError] = useState(false)
  const activeIndex = audioUrl ? activeTranscriptSegment(segments, currentTime) : -1

  useEffect(() => {
    setAudioError(false)
    setCurrentTime(0)
    setPlaying(false)
  }, [audioUrl])

  useEffect(() => {
    if (!playing || activeIndex < 0) return
    lineRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, playing])

  const seek = (seconds: number) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = seconds
    setCurrentTime(seconds)
    void audioRef.current.play().catch(() => setAudioError(true))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {audioUrl ? (
        <div className="sticky top-0 z-10 mb-5 rounded-xl border border-amber-300/55 bg-amber-50/90 p-3 shadow-sm backdrop-blur dark:border-amber-700/50 dark:bg-amber-950/35">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-xs font-medium text-amber-950 dark:text-amber-100">
              <span className="size-2 rounded-full bg-amber-400 shadow-[0_0_0_3px_rgb(251_191_36_/_0.18)]" />
              {t('audioFollowHighlight')}
            </p>
            <span className="readout text-[10px] text-amber-800/70 dark:text-amber-200/65">
              {transcriptTimestamp(currentTime)}
            </span>
          </div>
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            preload="metadata"
            aria-label={t('replayRecording', { name: label })}
            className="h-9 w-full"
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onCanPlay={() => setAudioError(false)}
            onError={() => {
              setAudioError(true)
              setPlaying(false)
            }}
            onPlay={() => {
              setAudioError(false)
              setPlaying(true)
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          {audioError ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {t('audioPlaybackFailed')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mb-5 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t('audioUnavailable')}
        </p>
      )}

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {editable ? t('editTimedPassages') : t('transcriptPreview')}
        </p>
        {audioUrl ? <p className="text-[11px] text-muted-foreground">{t('clickPassageToPlay')}</p> : null}
      </div>
      <div className="space-y-1.5 text-sm leading-7">
        {segments.map((segment, index) => {
          const highlighted = index === activeIndex
          return (
            <div
              key={`${segment.start}-${index}`}
              ref={(element) => { lineRefs.current[index] = element }}
              className={cn(
                'group grid grid-cols-[3.75rem_minmax(0,1fr)] gap-2 rounded-lg px-2 py-1.5 transition-colors duration-200 motion-reduce:transition-none',
                highlighted
                  ? 'bg-amber-200/80 text-amber-950 ring-1 ring-amber-300/80 dark:bg-amber-300/85 dark:text-amber-950'
                  : 'hover:bg-muted/55',
              )}
            >
              <button
                type="button"
                disabled={!audioUrl}
                onClick={() => seek(segment.start)}
                className={cn(
                  'readout mt-0.5 flex h-6 items-center gap-1 self-start rounded px-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
                  highlighted ? 'font-semibold text-amber-900' : 'text-blue-500',
                  audioUrl && 'hover:bg-background/60',
                )}
                aria-label={t('playFromTime', { time: transcriptTimestamp(segment.start) })}
              >
                {audioUrl ? <PlayIcon className="size-2.5 fill-current" /> : null}
                {transcriptTimestamp(segment.start)}
              </button>
              {editable ? (
                <textarea
                  value={segment.text}
                  rows={Math.max(1, Math.ceil(segment.text.length / 72))}
                  onChange={(event) => onChange?.(segments.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, text: event.target.value } : item,
                  ))}
                  aria-label={t('transcriptPassage', { number: index + 1 })}
                  className="min-h-9 w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1 leading-6 outline-none transition-colors placeholder:text-muted-foreground focus:border-blue-500/35 focus:bg-background focus:ring-2 focus:ring-blue-500/15"
                  spellCheck
                />
              ) : (
                <p className="min-w-0 whitespace-pre-wrap break-words px-2 text-foreground/90 group-hover:text-foreground">
                  {segment.text}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TranscriptEditorDialog({
  open,
  onOpenChange,
  row,
  detail,
  audioUrl,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: TranscriptionRow | null
  detail: TranscriptionDetail | null
  audioUrl: string | null
  onSave: (segments: TranscriptionSegment[]) => Promise<void>
}) {
  const { t } = usePreferences()
  const [segments, setSegments] = useState<TranscriptionSegment[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSegments(detail?.segments.map((segment) => ({ ...segment })) ?? [])
    setError(null)
  }, [detail, open])

  const save = async () => {
    if (!segments.length || segments.some((segment) => !segment.text.trim())) {
      setError(t('transcriptEmptyPassage'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(segments)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('transcriptSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="h-[min(52rem,calc(100vh-2rem))] sm:max-w-4xl">
        <DialogHeader className="border-b pr-14">
          <DialogTitle>{t('editTranscript')}</DialogTitle>
          <DialogDescription>
            {t('editTranscriptDescription', { name: row?.title ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-7">
          <TranscriptPlayer
            segments={segments}
            audioUrl={audioUrl}
            label={row?.title ?? t('transcriptions')}
            editable
            onChange={setSegments}
          />
        </div>
        <footer className="flex items-center justify-between gap-3 border-t bg-muted/20 px-5 py-3 sm:px-7">
          <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')} role={error ? 'alert' : undefined}>
            {error ?? t('transcriptEditorHint')}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={() => void save()} disabled={saving || !segments.length}>
              {saving ? <Spinner className="size-4" /> : <PencilLineIcon data-icon="inline-start" />}
              {t(saving ? 'saving' : 'saveChanges')}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function PreviewMessage({
  icon: Icon,
  title,
  description,
  progress,
  destructive = false,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  progress?: number
  destructive?: boolean
}) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-8 text-center">
      <Icon className={cn('size-7', destructive ? 'text-destructive' : 'text-muted-foreground')} />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {progress !== undefined ? <ProgressTrack value={progress} className="mt-2 max-w-xs" /> : null}
    </div>
  )
}

function ProgressDialog({
  open,
  onOpenChange,
  uploads,
  rows,
  onShow,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  uploads: LocalUpload[]
  rows: TranscriptionRow[]
  onShow: (id: string) => void
}) {
  const { t } = usePreferences()
  const allDone = uploads.every((upload) => upload.status === 'failed') && rows.length > 0 && rows.every((row) => !isActive(row.status))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {allDone ? <CheckIcon className="size-5 text-emerald-500" /> : <Spinner className="size-5 text-blue-500" />}
            {t(allDone ? 'processingComplete' : 'processingTranscriptions')}
          </DialogTitle>
          <DialogDescription>{t('processingDescription')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto px-6 pb-6" aria-live="polite">
          {uploads.map((upload) => (
            <ProgressRow
              key={upload.key}
              title={upload.title}
              status={upload.status === 'uploading' ? t('uploadingAudio') : t('transcriptionFailed')}
              description={upload.error ?? t('uploadProgress', { percent: upload.progress })}
              progress={upload.status === 'uploading' ? Math.max(3, upload.progress * 0.2) : 100}
              failed={upload.status === 'failed'}
            />
          ))}
          {rows.map((row) => (
            <ProgressRow
              key={row.id}
              title={row.title}
              status={statusLabel(t, row.status)}
              description={stageDescription(t, row.status, row.error)}
              progress={transcriptionProgress(row.status)}
              failed={row.status === 'failed'}
              action={row.status === 'done' ? (
                <Button variant="outline" size="xs" onClick={() => onShow(row.id)}>{t('showTranscript')}</Button>
              ) : null}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProgressRow({
  title,
  status,
  description,
  progress,
  failed,
  action,
}: {
  title: string
  status: string
  description: string
  progress: number
  failed: boolean
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3.5">
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', failed ? 'bg-destructive/10 text-destructive' : 'bg-blue-500/10 text-blue-500')}>
          {failed ? <AlertTriangleIcon className="size-4" /> : progress === 100 ? <CheckIcon className="size-4" /> : <FileAudioIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
            <span className={cn('text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>{status}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          <ProgressTrack value={progress} failed={failed} className="mt-3" />
          {action ? <div className="mt-3">{action}</div> : null}
        </div>
      </div>
    </div>
  )
}

function ProgressTrack({ value, failed = false, className }: { value: number; failed?: boolean; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-foreground/10', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-700 ease-out', failed ? 'bg-destructive' : 'bg-blue-500')}
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div><p className="text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-medium">{value}</p></div>
}

function statusLabel(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  status: TranscriptionStatus,
): string {
  switch (status) {
    case 'queued': return t('transcriptionQueued')
    case 'transcribing': return t('transcriptionTranscribing')
    case 'indexing': return t('transcriptionIndexing')
    case 'done': return t('transcriptionDone')
    case 'failed': return t('transcriptionFailed')
  }
}

function stageTitle(
  t: (key: TranslationKey) => string,
  status: TranscriptionStatus,
): string {
  return statusLabel(t, status)
}

function stageDescription(
  t: (key: TranslationKey) => string,
  status: TranscriptionStatus,
  error?: string | null,
): string {
  switch (status) {
    case 'queued': return t('waitingWorker')
    case 'transcribing': return t('whisperWorking')
    case 'indexing': return t('indexingTranscript')
    case 'done': return t('transcriptionReady')
    case 'failed': return error ?? t('transcriptNotReady')
  }
}

function isActive(status: TranscriptionStatus): boolean {
  return status === 'queued' || status === 'transcribing' || status === 'indexing'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}
