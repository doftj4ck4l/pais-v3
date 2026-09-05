import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, FileSpreadsheetIcon, PaperclipIcon, XIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ModelPicker } from '@/features/agents/components/model-picker'
import { Textarea } from '@/shared/ui/textarea'
import { Spinner } from '@/shared/ui/spinner'
import { uploadChatDataFile, uploadChatImage } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'
import type { ChatAttachments, Model, UploadedDataFile, UploadedImage } from '@/shared/lib/types'
import { usePreferences } from '@/shared/hooks/use-preferences'

const DATA_FILE_ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const isDataFile = (file: File) => /\.(csv|xlsx)$/i.test(file.name)

/**
 * Starts a new agent. It is never bound to a running agent — stopping one
 * happens on that agent's own header.
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
  lockedModelId = null,
  effort = null,
  onEffortChange,
  conversationId = null,
  docked = true,
}: {
  notice: string | null
  onDismissNotice: () => void
  onSend: (text: string, attachments: ChatAttachments) => void
  /** The catalog, for the picker under the input. Empty until /api/meta answers. */
  models: Model[]
  /** The model the next run will use — not the open one's, which never changes. */
  modelId: string
  onModelChange: (id: string) => void
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
}) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<UploadedImage[]>([])
  const [files, setFiles] = useState<UploadedDataFile[]>([])
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
    setError(null)
  }, [scope.workspaceId])

  useEffect(() => {
    if (!chatOnly || (!images.length && !files.length)) return
    setImages([])
    setFiles([])
    dataFileSlots.current = 0
    setError(t('filesRemovedChatOnly'))
  }, [chatOnly, files.length, images.length, t])

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

  const submit = () => {
    // An attachment with no question still has an obvious analysis intent.
    // An empty composer with nothing attached does not.
    if (!value.trim() && !images.length && !files.length) return
    if (uploading > 0) return
    const fallback = files.length
      ? files.length === 1
        ? t('analyzeFile')
        : t('analyzeFiles')
      : t('whatsInImage')
    onSend(value.trim() || fallback, { images, dataFiles: files })
    setValue('')
    setImages([])
    setFiles([])
    dataFileSlots.current = 0
    setError(null)
  }

  return (
    <div className={cn('bg-background', docked && 'border-t')}>
      {notice ? (
        <div className="mx-auto flex w-full max-w-5xl items-start gap-3 px-4 pt-3 sm:px-6">
          <p className="flex-1 border-l-2 border-foreground py-1 pl-3 text-xs text-muted-foreground">
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
        className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="rounded-xl border bg-card transition-colors focus-within:border-ring">
          {images.length || files.length || uploading > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
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
              {uploading > 0 ? (
                <span className="flex size-14 items-center justify-center rounded-md border border-dashed">
                  <Spinner className="size-4 text-muted-foreground" />
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-end gap-2 p-2 pl-3">
            <span
              aria-hidden
              className="readout hidden shrink-0 pb-2.5 leading-none text-muted-foreground select-none sm:inline"
            >
              →
            </span>

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
              disabled={chatOnly || uploading > 0}
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('attachData')}
              title={chatOnly ? t('chooseAgentFiles') : t('attachData')}
              className="mb-0.5 text-muted-foreground"
            >
              <PaperclipIcon />
            </Button>

            <Textarea
              ref={ref}
              rows={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
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
              className="max-h-[200px] min-h-0 resize-none border-0 bg-transparent px-0 py-2 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />

            <Button
              type="submit"
              disabled={(!value.trim() && !images.length && !files.length) || uploading > 0}
            >
              <span className="hidden sm:inline">{t('send')}</span>
              <ArrowUpIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-1.5 px-1 text-[0.6875rem] text-destructive">
            {error}
          </p>
        ) : null}

        {/* The model sits on the left of this row and the hint on the right, so
            the control the user changes is the one nearest the input's own
            edge rather than trailing a sentence about images. */}
        <div className="mt-1.5 flex items-center gap-3 px-1 text-[0.6875rem] text-muted-foreground">
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

function DataFileChip({ file, onRemove }: { file: UploadedDataFile; onRemove: () => void }) {
  const { t } = usePreferences()
  return (
    <span className="group flex h-14 max-w-64 items-center gap-2 rounded-md border bg-background px-2.5">
      <FileSpreadsheetIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{file.name}</span>
        <span className="block text-[0.625rem] tracking-wide text-muted-foreground uppercase">
          {file.name.toLowerCase().endsWith('.csv') ? 'CSV' : 'Excel'} · {formatBytes(file.bytes)}
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
