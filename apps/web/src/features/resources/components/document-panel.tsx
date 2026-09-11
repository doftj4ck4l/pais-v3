import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Spinner } from '@/shared/ui/spinner'
import { PanelEmpty } from '@/features/resources/components/panel-kit'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { groupByDate } from '@/features/resources/lib/resource-browser'
import { deleteDocument, getDocument, listDocuments, uploadDocuments } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { localeFor } from '@/shared/lib/i18n'
import type { DocumentDetail, DocumentRow, IngestResult } from '@/shared/lib/types'
import type { TranslationKey } from '@/shared/lib/i18n'
import { cn } from '@/shared/lib/utils'

export function DocumentPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [docs, setDocs] = useState<DocumentRow[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [results, setResults] = useState<IngestResult[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null)
  const scope = useScope()
  const { language, t } = usePreferences()

  const refresh = useCallback(async () => {
    try {
      setDocs(await listDocuments(scope))
    } catch {
      // Keep the last useful browser state through a transient request failure.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setUploadOpen(true)
    try {
      setResults(await uploadDocuments(scope, files))
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh, scope])

  const indexed = docs.filter((doc) => doc.status === 'indexed')
  useEffect(() => onCountChange?.(indexed.length), [indexed.length, onCountChange])

  const folders = useMemo(
    () => groupByDate(docs, (doc) => doc.createdAt, {
      locale: localeFor(language),
      today: t('today'),
      yesterday: t('yesterday'),
    }),
    [docs, language, t],
  )

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(localeFor(language))
    return folders
      .filter((folder) => selectedFolder === 'all' || folder.key === selectedFolder)
      .map((folder) => ({
        ...folder,
        rows: folder.rows.filter((doc) => doc.title.toLocaleLowerCase(localeFor(language)).includes(needle)),
      }))
      .filter((folder) => folder.rows.length)
  }, [folders, language, query, selectedFolder])

  const visibleRows = useMemo(() => visibleGroups.flatMap((folder) => folder.rows), [visibleGroups])
  const selected = docs.find((doc) => doc.id === selectedId) ?? null

  useEffect(() => {
    if (visibleRows.length && !visibleRows.some((doc) => doc.id === selectedId)) {
      setSelectedId(visibleRows[0]!.id)
    } else if (!visibleRows.length) {
      setSelectedId(null)
    }
  }, [selectedId, visibleRows])

  useEffect(() => {
    setCopied(false)
    if (!selected || selected.status !== 'indexed') {
      setDetail(null)
      setDetailLoading(false)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    void getDocument(scope, selected.id)
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
  }, [scope, selected])

  const remove = useCallback(async (doc: DocumentRow) => {
    setDocs((current) => current.filter((item) => item.id !== doc.id))
    setPendingDelete(null)
    if (selectedId === doc.id) setSelectedId(null)
    try {
      await deleteDocument(scope, doc.id)
    } finally {
      await refresh()
    }
  }, [refresh, scope, selectedId])

  const openUpload = () => {
    setResults([])
    setUploadOpen(true)
  }

  const inputId = 'documents-upload-input'

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
        void upload(Array.from(event.dataTransfer.files).filter((file) => file.type === 'application/pdf'))
      }}
    >
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />

      <DocumentToolbar query={query} onQueryChange={setQuery} busy={busy} inputId={inputId} />

      {docs.length ? (
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-y-auto lg:grid-cols-[13rem_minmax(20rem,0.9fr)_minmax(22rem,1.15fr)] lg:overflow-hidden">
          <DocumentFolderRail folders={folders} selected={selectedFolder} onSelect={setSelectedFolder} />
          <DocumentList
            groups={visibleGroups}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={setPendingDelete}
            empty={query ? t('noMatchingDocuments') : t('noDocuments')}
          />
          <DocumentPreview
            doc={selected}
            detail={detail}
            loading={detailLoading}
            copied={copied}
            onCopy={() => {
              const content = detail?.document.content
              if (!content) return
              void navigator.clipboard.writeText(content).then(() => setCopied(true))
            }}
          />
        </div>
      ) : (
        <PanelEmpty
          icon={FileTextIcon}
          title={t('noDocuments')}
          description={t('noDocumentsDescription')}
          className="min-h-0 flex-1 border-t"
          action={
            <Button size="sm" onClick={openUpload}>
              <UploadIcon data-icon="inline-start" />
              {t('uploadPdfs')}
            </Button>
          }
        />
      )}

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-blue-500/50 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderOpenIcon className="size-10 fill-blue-500/15 text-blue-500" />
            <p className="text-sm font-medium">{t('dropPdfs')}</p>
          </div>
        </div>
      ) : null}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (!open) setResults([])
        }}
        busy={busy}
        results={results}
        onFiles={(files) => void upload(files)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={pendingDelete ? t('removeDocument', { name: pendingDelete.title }) : t('remove')}
        description={t('removeDocumentDescription', { name: pendingDelete?.title ?? '' })}
        confirmLabel={t('remove')}
        onConfirm={() => pendingDelete ? void remove(pendingDelete) : undefined}
      />
    </div>
  )
}

function DocumentToolbar({
  query,
  onQueryChange,
  busy,
  inputId,
}: {
  query: string
  onQueryChange: (value: string) => void
  busy: boolean
  inputId: string
}) {
  const { t } = usePreferences()
  return (
    <header className="flex min-h-14 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2 sm:gap-3 sm:px-4">
      <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-sm font-medium sm:w-auto">
        <FolderOpenIcon className="size-4 fill-blue-500/15 text-blue-500" />
        <span>{t('docs')}</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate text-muted-foreground">{t('allDocuments')}</span>
      </div>
      <div className="flex w-full min-w-0 items-center justify-end gap-2 sm:ml-auto sm:w-auto">
        {busy ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        <label className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('searchDocuments')}
            aria-label={t('searchDocuments')}
            className="h-8 w-full rounded-lg border bg-background pr-3 pl-8 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-blue-500/25"
          />
        </label>
        <Button
          size="sm"
          onClick={() => document.getElementById(inputId)?.click()}
          aria-label={t('uploadPdfs')}
        >
          <UploadIcon data-icon="inline-start" />
          <span className="hidden sm:inline">{t('uploadPdfs')}</span>
        </Button>
      </div>
    </header>
  )
}

function DocumentFolderRail({
  folders,
  selected,
  onSelect,
}: {
  folders: ReturnType<typeof groupByDate<DocumentRow>>
  selected: string
  onSelect: (key: string) => void
}) {
  const { t } = usePreferences()
  const items = [
    { key: 'all', label: t('allDocuments'), count: folders.reduce((count, folder) => count + folder.rows.length, 0) },
    ...folders.map((folder) => ({ key: folder.key, label: folder.label, count: folder.rows.length })),
  ]

  return (
    <aside className="border-b bg-muted/25 p-2 lg:border-r lg:border-b-0" aria-label={t('documentFolders')}>
      <p className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t('documentFolders')}
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

function DocumentList({
  groups,
  selectedId,
  onSelect,
  onRemove,
  empty,
}: {
  groups: ReturnType<typeof groupByDate<DocumentRow>>
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (doc: DocumentRow) => void
  empty: string
}) {
  const { t } = usePreferences()
  if (!groups.length) {
    return <div className="flex min-h-48 items-center justify-center border-b px-6 text-center text-sm text-muted-foreground lg:border-r lg:border-b-0">{empty}</div>
  }

  return (
    <section className="min-h-0 min-w-0 overflow-y-auto border-b lg:border-r lg:border-b-0" aria-label={t('allDocuments')}>
      <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_5rem_5rem] border-b bg-card/95 px-3 py-2 text-[11px] font-medium text-muted-foreground backdrop-blur-sm sm:grid">
        <span>{t('name')}</span><span>{t('pages')}</span><span>{t('size')}</span>
      </div>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="sticky top-0 z-[5] flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground backdrop-blur-sm sm:top-[33px]">
            <FolderIcon className="size-3.5 fill-blue-500/15 text-blue-500" />
            <span>{group.label}</span>
            <span className="font-normal">{group.rows.length}</span>
          </div>
          <ul>
            {group.rows.map((doc) => {
              const active = doc.id === selectedId
              const warning = doc.status !== 'indexed' || Boolean(doc.error)
              return (
                <li key={doc.id} className={cn('group relative border-b last:border-b-0', active && 'bg-blue-500 text-white')}>
                  <button
                    type="button"
                    onClick={() => onSelect(doc.id)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300 sm:grid-cols-[minmax(0,1fr)_5rem_5rem]"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      {warning ? (
                        <AlertTriangleIcon className={cn('size-4 shrink-0', active ? 'text-white' : 'text-amber-500')} />
                      ) : (
                        <FileTextIcon className={cn('size-4 shrink-0', active ? 'text-white' : 'text-blue-500')} />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{doc.title}</span>
                        <span className={cn('mt-0.5 block text-[11px] sm:hidden', active ? 'text-white/75' : 'text-muted-foreground')}>
                          {documentStatus(t, doc)} · {formatBytes(doc.bytes)}
                        </span>
                      </span>
                    </span>
                    <span className={cn('readout hidden text-[11px] sm:block', active ? 'text-white/75' : 'text-muted-foreground')}>
                      {doc.pages}
                    </span>
                    <span className={cn('readout hidden text-[11px] sm:block', active ? 'text-white/75' : 'text-muted-foreground')}>
                      {formatBytes(doc.bytes)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(doc)}
                    aria-label={t('removeDocument', { name: doc.title })}
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

function DocumentPreview({
  doc,
  detail,
  loading,
  copied,
  onCopy,
}: {
  doc: DocumentRow | null
  detail: DocumentDetail | null
  loading: boolean
  copied: boolean
  onCopy: () => void
}) {
  const { language, t } = usePreferences()
  if (!doc) {
    return (
      <section className="flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <FileTextIcon className="size-8 stroke-[1.4]" />
        <p className="max-w-xs text-sm leading-relaxed">{t('selectDocument')}</p>
      </section>
    )
  }

  const content = detail?.document.content ?? null
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background" aria-label={t('documentPreview')}>
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
          <FileTextIcon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{doc.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {documentStatus(t, doc)} · {new Intl.DateTimeFormat(localeFor(language), {
              dateStyle: 'medium', timeStyle: 'short',
            }).format(doc.createdAt)}
          </p>
        </div>
        {content ? (
          <Button variant="ghost" size="icon-sm" onClick={onCopy} aria-label={t('copyDocument')}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full min-h-64 items-center justify-center"><Spinner className="size-5 text-muted-foreground" /></div>
        ) : content ? (
          <article className="mx-auto max-w-3xl px-6 py-6">
            <p className="mb-5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t('documentText')}</p>
            <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground/90">{content}</div>
          </article>
        ) : (
          <PreviewMessage
            title={documentStatus(t, doc)}
            description={doc.error ?? (doc.status === 'empty' ? t('noTextLayer') : t('documentUnavailable'))}
            destructive={doc.status === 'error'}
          />
        )}
      </div>

      <footer className="grid grid-cols-3 gap-3 border-t bg-muted/20 px-4 py-3 text-xs">
        <Metadata label={t('pages')} value={String(doc.pages)} />
        <Metadata label={t('chunks')} value={String(doc.chunkCount)} />
        <Metadata label={t('size')} value={formatBytes(doc.bytes)} />
      </footer>
    </section>
  )
}

function PreviewMessage({
  title,
  description,
  destructive = false,
}: {
  title: string
  description: string
  destructive?: boolean
}) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangleIcon className={cn('size-7', destructive ? 'text-destructive' : 'text-muted-foreground')} />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function documentStatus(
  t: (key: TranslationKey) => string,
  doc: DocumentRow,
): string {
  if (doc.status === 'indexed') return doc.error ? t('partial') : t('documentIndexed')
  if (doc.status === 'empty') return t('documentEmpty')
  return t('documentError')
}

function UploadDialog({
  open,
  onOpenChange,
  busy,
  results,
  onFiles,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  results: IngestResult[]
  onFiles: (files: File[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const { t } = usePreferences()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('uploadDocuments')}</DialogTitle>
          <DialogDescription>{t('uploadDocumentsDescription')}</DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            onFiles(Array.from(event.dataTransfer.files).filter((file) => file.type === 'application/pdf'))
          }}
          disabled={busy}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10',
            'text-sm text-muted-foreground transition-colors',
            'hover:border-foreground/30 hover:text-foreground disabled:opacity-60',
            over && 'border-foreground/40 bg-accent text-foreground',
          )}
        >
          {busy ? <Spinner className="size-5" /> : <UploadIcon className="size-5" />}
          <span>{busy ? t('indexing') : t('dropPdfs')}</span>
        </button>

        {results.length ? (
          <ul className="flex max-h-52 flex-col gap-1 overflow-y-auto">
            {results.map((result, index) => (
              <li key={`${result.title}-${index}`} className="flex items-start gap-2 text-sm">
                {result.status === 'indexed' ? (
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{result.title}</span>
                  <span className="readout block text-muted-foreground">
                    {result.status === 'indexed'
                      ? t('pagesAndChunks', { pages: result.pages, chunks: result.chunks })
                      : (result.error ?? t('couldNotRead'))}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('statusDone')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div><p className="text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-medium">{value}</p></div>
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
