import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  PaperclipIcon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ModelPicker } from '@/features/agents/components/model-picker'
import { Textarea } from '@/shared/ui/textarea'
import { Spinner } from '@/shared/ui/spinner'
import { listDocuments, uploadChatDataFile, uploadChatImage } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'
import { documentMentionAt } from '@/features/agents/lib/document-mentions'
import type {
  ChatAttachments,
  ConversationMode,
  DocumentRow,
  MentionedDocument,
  Model,
  UploadedDataFile,
  UploadedImage,
} from '@/shared/lib/types'
import { usePreferences } from '@/shared/hooks/use-preferences'

const DATA_FILE_ACCEPT =
  '.csv,.xlsx,.pdf,.docx,.pptx,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation'

const isDataFile = (file: File) => /\.(csv|xlsx|pdf|docx|pptx)$/i.test(file.name)

const DATA_FILE_LABELS: Record<string, string> = {
  csv: 'CSV',
  xlsx: 'Excel',
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
}

const dataFileLabel = (name: string) =>
  DATA_FILE_LABELS[name.toLowerCase().split('.').pop() ?? ''] ?? 'File'

/**
 * Starts a new agent or continues the selected one. A send during an active
 * turn is queued by the board and runs on the same conversation afterwards.
 *
 * Attachments are uploaded before send, so their preview appears while the
 * user is still typing and the chat request carries references rather than
 * megabytes of file data.
 */
export function Composer({
  notice,
  onDismissNotice,
  onSend,
  models,
  modelId,
  onModelChange,
  mode,
  lockedMode = null,
  lockedModelId = null,
  effort = null,
  onEffortChange,
  conversationId = null,
  docked = true,
  queueing = false,
}: {
  notice: string | null
  onDismissNotice: () => void
  onSend: (text: string, attachments: ChatAttachments) => void
  /** The catalog, for the picker under the input. Empty until /api/meta answers. */
  models: Model[]
  /** The model the next run will use — not the open one's, which never changes. */
  modelId: string
  onModelChange: (id: string) => void
  /** Chat is direct; Work is the full agent harness. */
  mode: ConversationMode
  /** The open conversation's mode cannot change mid-thread. */
  lockedMode?: ConversationMode | null
  /** The open chat's model, if one is open — it reports rather than offers. */
  lockedModelId?: string | null
  /** Chosen reasoning effort, for a thinking model; null when not applicable. */
  effort?: string | null
  onEffortChange?: (level: string) => void
  /** The open session, so a pasted image is stored against it. Null on a new run. */
  conversationId?: string | null
  /** False while it sits mid-page waiting for the first question, where a rule
   *  across the window would divide a page that has nothing above it. */
  docked?: boolean
  /** The selected conversation is active, so this send will wait behind it. */
  queueing?: boolean
}) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<UploadedImage[]>([])
  const [files, setFiles] = useState<UploadedDataFile[]>([])
  const [mentionedDocuments, setMentionedDocuments] = useState<MentionedDocument[]>([])
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentGeneration = useRef(0)
  const scope = useScope()
  const dataFileSlots = useRef(0)
  const workspaceIdRef = useRef(scope.workspaceId)
  const activeModel = models.find((m) => m.id === (lockedModelId ?? modelId))
  const chatOnly = activeModel?.mode === 'chat-only'
  const activeMode = lockedMode ?? mode
  const directChat = activeMode === 'chat'
  const { t } = usePreferences()

  useEffect(() => {
    if (chatOnly) attachmentGeneration.current += 1
  }, [chatOnly])

  useEffect(() => {
    if (workspaceIdRef.current === scope.workspaceId) return
    workspaceIdRef.current = scope.workspaceId
    attachmentGeneration.current += 1
    dataFileSlots.current = 0
    setImages([])
    setFiles([])
    setMentionedDocuments([])
    setMentionQuery(null)
    setError(null)
  }, [scope.workspaceId])

  useEffect(() => {
    if (!scope.workspaceId || !directChat) {
      setDocuments([])
      return
    }
    let live = true
    void listDocuments(scope)
      .then((rows) => {
        if (live) setDocuments(rows.filter((document) => document.status === 'indexed'))
      })
      .catch(() => live && setDocuments([]))
    return () => {
      live = false
    }
  }, [directChat, scope])

  useEffect(() => {
    if (!chatOnly || (!images.length && !files.length)) return
    setImages([])
    setFiles([])
    dataFileSlots.current = 0
    setError(t('filesRemovedChatOnly'))
  }, [chatOnly, files.length, images.length, t])

  useEffect(() => {
    if (!directChat && mentionedDocuments.length) setMentionedDocuments([])
    if (!directChat) setMentionQuery(null)
    if (directChat && files.length) {
      setFiles([])
      dataFileSlots.current = 0
      setError(t('chooseWorkFiles'))
    }
  }, [directChat, files.length, mentionedDocuments.length, t])

  // Grow with the prompt, up to a ceiling.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const uploadBatch = useCallback(
    async <T,>(
      selected: File[],
      upload: (file: File) => Promise<T>,
      append: (items: T[]) => void,
      unavailableMessage: string,
    ) => {
      if (!selected.length) return 0
      if (chatOnly) {
        setError(unavailableMessage)
        return 0
      }
      setError(null)
      setUploading((n) => n + selected.length)
      const generation = attachmentGeneration.current
      try {
        const results = await settleWithConcurrency(selected, upload, 2)
        if (attachmentGeneration.current !== generation) return 0
        const completed = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        )
        if (completed.length) append(completed)
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') setError((failed.reason as Error).message)
        return completed.length
      } finally {
        setUploading((n) => n - selected.length)
      }
    },
    [chatOnly],
  )

  const attachImages = useCallback(
    (selected: File[]) =>
      uploadBatch(
        selected,
        (file) => uploadChatImage(scope, file, conversationId),
        (uploaded) => setImages((prev) => [...prev, ...uploaded]),
        t('chooseAgentImages'),
      ),
    [conversationId, scope, t, uploadBatch],
  )

  const attachDataFiles = useCallback(
    async (selected: File[]) => {
      const available = Math.max(0, 6 - dataFileSlots.current)
      const accepted = selected.slice(0, available)
      const generation = attachmentGeneration.current
      dataFileSlots.current += accepted.length
      const completed = await uploadBatch(
        accepted,
        (file) => uploadChatDataFile(scope, file),
        (uploaded) => setFiles((prev) => [...prev, ...uploaded]),
        t('chooseAgentAnalyze'),
      )
      if (attachmentGeneration.current !== generation) return
      dataFileSlots.current = Math.max(
        0,
        dataFileSlots.current - (accepted.length - completed),
      )
      if (selected.length > accepted.length) {
        setError((current) => current ?? t('attachLimit'))
      }
    },
    [scope, t, uploadBatch],
  )

  const mentionMatches =
    mentionQuery === null || mentionedDocuments.length >= 6
      ? []
      : documents
          .filter(
            (document) =>
              !mentionedDocuments.some((selected) => selected.id === document.id) &&
              document.title.toLowerCase().includes(mentionQuery.toLowerCase()),
          )
          .slice(0, 6)

  const selectDocumentMention = (document: DocumentRow) => {
    const cursor = ref.current?.selectionStart ?? value.length
    const range = documentMentionAt(value, cursor)
    if (!range) return
    const before = value.slice(0, range.start)
    const after = value.slice(range.end)
    const inserted = `@${document.title}`
    const next = `${before}${inserted} ${after}`
    setValue(next)
    setMentionedDocuments((current) => [
      ...current,
      { id: document.id, title: document.title },
    ])
    setMentionQuery(null)
    setMentionIndex(0)
    requestAnimationFrame(() => {
      const position = before.length + inserted.length + 1
      ref.current?.focus()
      ref.current?.setSelectionRange(position, position)
    })
  }

  const submit = () => {
    // An attachment with no question still has an obvious analysis intent.
    // An empty composer with nothing attached does not.
    if (!value.trim() && !images.length && !files.length && !mentionedDocuments.length) return
    if (uploading > 0) return
    const fallback = mentionedDocuments.length
      ? t('summarizeDocuments')
      : files.length
        ? files.length === 1
          ? t('analyzeFile')
          : t('analyzeFiles')
        : t('whatsInImage')
    onSend(value.trim() || fallback, {
      images,
      dataFiles: files,
      documents: mentionedDocuments,
    })
    setValue('')
    setImages([])
    setFiles([])
    setMentionedDocuments([])
    setMentionQuery(null)
    dataFileSlots.current = 0
    setError(null)
  }

  return (
    <div
      className={cn(
        'bg-background',
        docked && 'bg-gradient-to-t from-background via-background to-transparent pt-2',
      )}
    >
      {notice ? (
        <div className="mx-auto flex w-full max-w-3xl items-start gap-3 px-4 pt-2 sm:px-6">
          <p className="flex-1 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            {notice}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismissNotice}
            className="-mr-1 text-muted-foreground"
          >
            {t('dismiss')}
          </Button>
        </div>
      ) : null}

      <form
        className="mx-auto w-full max-w-3xl px-3 pt-2 pb-3 sm:px-6 sm:pb-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="relative overflow-visible rounded-[1.75rem] border border-border/80 bg-secondary shadow-[0_2px_8px_rgba(0,0,0,0.05)] transition-shadow focus-within:shadow-[0_3px_12px_rgba(0,0,0,0.08)] dark:border-transparent">
          {mentionQuery !== null && mentionMatches.length ? (
            <DocumentMentionMenu
              documents={mentionMatches}
              activeIndex={mentionIndex}
              onPick={selectDocumentMention}
            />
          ) : null}

          {images.length || files.length || mentionedDocuments.length || uploading > 0 ? (
            <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
              {images.map((image) => (
                <Thumbnail
                  key={image.id}
                  image={image}
                  onRemove={() => setImages((prev) => prev.filter((i) => i.id !== image.id))}
                />
              ))}
              {files.map((file) => (
                <DataFileChip
                  key={file.path}
                  file={file}
                  onRemove={() => {
                    dataFileSlots.current = Math.max(0, dataFileSlots.current - 1)
                    setFiles((prev) => prev.filter((item) => item.path !== file.path))
                  }}
                />
              ))}
              {mentionedDocuments.map((document) => (
                <DocumentChip
                  key={document.id}
                  document={document}
                  onRemove={() =>
                    setMentionedDocuments((current) =>
                      current.filter((item) => item.id !== document.id),
                    )
                  }
                />
              ))}
              {uploading > 0 ? (
                <span className="flex size-14 items-center justify-center rounded-md border border-dashed">
                  <Spinner className="size-4 text-muted-foreground" />
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-end gap-1.5 px-2 pt-3 pb-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={DATA_FILE_ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => {
                void attachDataFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={chatOnly || directChat || uploading > 0}
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('attachData')}
              title={
                chatOnly ? t('chooseAgentFiles') : directChat ? t('chooseWorkFiles') : t('attachData')
              }
              className="mb-0.5 rounded-full text-muted-foreground hover:bg-background/80"
            >
              <PaperclipIcon />
            </Button>

            <Textarea
              ref={ref}
              rows={1}
              value={value}
              onChange={(e) => {
                const next = e.target.value
                setValue(next)
                if (!directChat) return
                const mention = documentMentionAt(next, e.target.selectionStart ?? next.length)
                setMentionQuery(mention?.query ?? null)
                setMentionIndex(0)
              }}
              onPaste={(e) => {
                // Only claim the paste when it actually carries a file. A
                // screenshot arrives as an image item with no text; copied text
                // from a browser often carries an image/* item too, so text
                // wins whenever there is any.
                if (e.clipboardData.getData('text')) return
                const files = Array.from(e.clipboardData.files).filter((f) =>
                  f.type.startsWith('image/'),
                )
                if (!files.length) return
                e.preventDefault()
                void attachImages(files)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const dropped = Array.from(e.dataTransfer.files)
                const droppedImages = dropped.filter((file) => file.type.startsWith('image/'))
                const droppedData = dropped.filter(isDataFile)
                if (!droppedImages.length && !droppedData.length) return
                e.preventDefault()
                void attachImages(droppedImages)
                void attachDataFiles(droppedData)
              }}
              onKeyDown={(e) => {
                if (mentionQuery !== null && mentionMatches.length) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const delta = e.key === 'ArrowDown' ? 1 : -1
                    setMentionIndex((current) =>
                      (current + delta + mentionMatches.length) % mentionMatches.length,
                    )
                    return
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const selected = mentionMatches[mentionIndex] ?? mentionMatches[0]
                    if (selected) selectDocumentMention(selected)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setMentionQuery(null)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={
                files.length
                  ? t('askAnalyze')
                  : images.length
                    ? t('askImage')
                    : chatOnly
                      ? t('askAnythingChatOnly')
                      : t('askAnything')
              }
              aria-label={t('startAgent')}
              className="max-h-[200px] min-h-0 resize-none border-0 bg-transparent px-2 py-2.5 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
            />

            <Button
              type="submit"
              size="icon"
              aria-label={queueing ? t('queueMessageAction') : t('send')}
              title={queueing ? t('queueMessageAction') : t('send')}
              disabled={
                (!value.trim() && !images.length && !files.length && !mentionedDocuments.length) ||
                uploading > 0
              }
              className="mb-0.5 size-8 rounded-full"
            >
              <ArrowUpIcon />
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-1.5 px-1 text-[0.6875rem] text-destructive">
            {error}
          </p>
        ) : null}

        {/* Message-level controls stay with the composer. Chat/Work lives in
            the top bar because it defines the whole conversation. */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 text-[0.6875rem] text-muted-foreground">
          <ModelPicker
            models={models}
            modelId={modelId}
            onChange={onModelChange}
            lockedId={lockedModelId}
          />

          {(() => {
            // The model the next send will use decides whether an effort control
            // belongs here at all — only a thinking model carries the levels.
            const thinking = activeModel?.thinking
            if (!thinking || !onEffortChange) return null
            return (
              <EffortControl
                levels={thinking.levels}
                value={effort ?? thinking.default}
                onChange={onEffortChange}
              />
            )
          })()}

          <p className="hidden min-w-0 items-center gap-1.5 truncate sm:flex">
            {chatOnly ? (
              <span>{t('chatOnlyHint')}</span>
            ) : directChat ? (
              <span>{t('chatModeHint')}</span>
            ) : (
              <>
                <PaperclipIcon className="size-3 shrink-0" />
                {t('attachmentHint')}
              </>
            )}
          </p>
        </div>
      </form>
    </div>
  )
}

function DocumentMentionMenu({
  documents,
  activeIndex,
  onPick,
}: {
  documents: DocumentRow[]
  activeIndex: number
  onPick: (document: DocumentRow) => void
}) {
  const { t } = usePreferences()
  return (
    <div
      className="absolute bottom-[calc(100%+0.5rem)] left-3 z-40 w-[min(26rem,calc(100%-1.5rem))] overflow-hidden rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-xl"
      role="listbox"
      aria-label={t('mentionDocument')}
    >
      <div className="flex items-center gap-2 px-2.5 py-2 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        <FileTextIcon className="size-3.5" />
        {t('mentionDocument')}
      </div>
      {documents.map((document, index) => (
        <button
          key={document.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(document)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
            index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70',
          )}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background">
            <FileTextIcon className="size-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{document.title}</span>
        </button>
      ))}
    </div>
  )
}

function DocumentChip({
  document,
  onRemove,
}: {
  document: MentionedDocument
  onRemove: () => void
}) {
  const { t } = usePreferences()
  return (
    <span className="group flex h-10 max-w-64 items-center gap-2 rounded-xl border bg-background px-2.5">
      <span className="text-xs font-semibold text-primary">@</span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{document.title}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('removeFile', { name: document.title })}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  )
}

function DataFileChip({ file, onRemove }: { file: UploadedDataFile; onRemove: () => void }) {
  const { t } = usePreferences()
  return (
    <span className="group flex h-14 max-w-64 items-center gap-2 rounded-md border bg-background px-2.5">
      <FileSpreadsheetIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{file.name}</span>
        <span className="block text-[0.625rem] tracking-wide text-muted-foreground uppercase">
          {dataFileLabel(file.name)} · {formatBytes(file.bytes)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('removeFile', { name: file.name })}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  )
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1000))}KB`
}

async function settleWithConcurrency<T>(
  inputs: File[],
  worker: (file: File) => Promise<T>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(inputs.length)
  let next = 0

  async function runWorker() {
    for (;;) {
      const index = next++
      if (index >= inputs.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(inputs[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, runWorker))
  return results
}

function Thumbnail({ image, onRemove }: { image: UploadedImage; onRemove: () => void }) {
  const { t } = usePreferences()
  return (
    <span className="group relative block size-14 overflow-hidden rounded-md border">
      <img src={image.url} alt={image.name} className="size-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('removeFile', { name: image.name })}
        className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-background/90 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  )
}

/**
 * A ChatGPT-style effort selector for a thinking model — how hard it reasons.
 *
 * Segmented pills rather than a drag-slider: the levels are few and named, and a
 * pill reads its value at a glance where a slider needs a label. Only rendered
 * for a model that declares `thinking`, so it is absent for every plain model.
 */
function EffortControl({
  levels,
  value,
  onChange,
}: {
  levels: string[]
  value: string
  onChange: (level: string) => void
}) {
  const { t } = usePreferences()
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-full border p-0.5"
      role="radiogroup"
      aria-label={t('reasoningEffort')}
    >
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          onClick={() => onChange(level)}
          className={cn(
            'rounded-full px-2 py-0.5 text-[0.625rem] capitalize transition-colors outline-none',
            value === level
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {level}
        </button>
      ))}
    </div>
  )
}
