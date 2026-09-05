import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, CheckIcon, FileTextIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Spinner } from '@/shared/ui/spinner'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { deleteDocument, listDocuments, uploadDocuments } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import type { DocumentRow, IngestResult } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'

/**
 * Upload PDFs and see what the agent can actually search.
 *
 * A document that failed to index is listed alongside the ones that worked,
 * carrying its reason. A scanned PDF looks identical to a good one until you try
 * to search it, so the panel says so at upload time rather than leaving the user
 * to conclude that retrieval is broken.
 */
export function DocumentPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [docs, setDocs] = useState<DocumentRow[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  /** What the last upload made of each file, shown in the dialog it happened in. */
  const [results, setResults] = useState<IngestResult[]>([])
  const scope = useScope()
  const { t } = usePreferences()

  const refresh = useCallback(async () => {
    try {
      setDocs(await listDocuments(scope))
    } catch {
      // The panel is secondary to the console; a listing failure is not fatal.
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setBusy(true)
      setUploadOpen(true)
      try {
        setResults(await uploadDocuments(scope, files))
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [refresh, scope],
  )

  const remove = useCallback(
    async (id: string) => {
      setDocs((prev) => prev.filter((d) => d.id !== id)) // optimistic
      await deleteDocument(scope, id)
      await refresh()
    },
    [refresh, scope],
  )

  const indexed = docs.filter((d) => d.status === 'indexed')
  useEffect(() => onCountChange?.(indexed.length), [indexed.length, onCountChange])
  const chunkTotal = indexed.reduce((n, d) => n + d.chunkCount, 0)

  const openUpload = () => {
    setResults([])
    setUploadOpen(true)
  }

  return (
    // The whole panel is also a drop target. A dashed bar to aim at was a drawer's
    // answer to having no room; on a page you can drop a PDF anywhere on it.
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
        void upload(Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf'))
      }}
    >
      <PanelHeader
        busy={busy}
        summary={
              indexed.length
            ? t('documentsSummary', {
                documents: `${indexed.length} ${t(indexed.length === 1 ? 'documentSingular' : 'documentPlural')}`,
                chunks: chunkTotal,
              })
            : null
        }
        action={
          docs.length ? (
            <Button size="sm" onClick={openUpload}>
              <UploadIcon data-icon="inline-start" />
              {t('uploadPdfs')}
            </Button>
          ) : null
        }
      />

      {docs.length ? (
        <PanelGrid>
          {docs.map((doc) => (
            <DocumentItem key={doc.id} doc={doc} onRemove={() => void remove(doc.id)} />
          ))}
        </PanelGrid>
      ) : (
        <PanelEmpty
          icon={FileTextIcon}
          title={t('noDocuments')}
          description={t('noDocumentsDescription')}
          action={
            <Button size="sm" onClick={openUpload}>
              <UploadIcon data-icon="inline-start" />
              {t('uploadPdfs')}
            </Button>
          }
        />
      )}

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
    </div>
  )
}

/**
 * Uploading happens in a dialog, not by throwing up the operating system's file
 * picker on a click. The picker can only say "these files"; what someone wants
 * to know is what happened to each of them — a scanned PDF is accepted, indexes
 * to nothing, and looks exactly like a working one until a search comes back
 * empty. The dialog is where that answer fits.
 */
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
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []))
            e.target.value = '' // let the same file be re-uploaded after a delete
          }}
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            onFiles(Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf'))
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
            {results.map((result, i) => (
              <li key={`${result.title}-${i}`} className="flex items-start gap-2 text-sm">
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

function DocumentItem({ doc, onRemove }: { doc: DocumentRow; onRemove: () => void }) {
  const { t } = usePreferences()
  const failed = doc.status !== 'indexed'
  // An indexed document can still carry a note — pages that needed OCR were
  // skipped. Worth the same warning icon: partial coverage looks exactly like
  // full coverage until a search comes back empty.
  const partial = !failed && !!doc.error

  return (
    <ItemCard
      leading={
        failed || partial ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{doc.error ?? doc.status}</TooltipContent>
          </Tooltip>
        ) : (
          <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )
      }
      title={<span className={cn(failed && 'text-muted-foreground')}>{doc.title}</span>}
      meta={
        failed
          ? doc.status === 'empty'
            ? t('noTextLayer')
            : t('couldNotRead')
          : `${t('pagesAndChunks', { pages: doc.pages, chunks: doc.chunkCount })}${partial ? ` · ${t('partial')}` : ''}`
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={t('removeDocument', { name: doc.title })}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon />
        </Button>
      }
    />
  )
}
