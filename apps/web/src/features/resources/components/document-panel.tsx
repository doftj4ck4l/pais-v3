import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, FileTextIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { deleteDocument, listDocuments, uploadDocuments } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { DocumentRow } from '@/shared/lib/types'
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
  const inputRef = useRef<HTMLInputElement>(null)
  const scope = useScope()

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
      try {
        await uploadDocuments(scope, files)
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

  return (
    // The whole panel is the drop target. A dashed bar to aim at was a drawer's
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
            ? `${indexed.length} doc${indexed.length === 1 ? '' : 's'} · ${chunkTotal} chunks`
            : null
        }
        action={
          docs.length ? (
            <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
              <UploadIcon data-icon="inline-start" />
              {busy ? 'Indexing…' : 'Upload PDFs'}
            </Button>
          ) : null
        }
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []))
          e.target.value = '' // let the same file be re-uploaded after a delete
        }}
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
          title="No documents yet"
          description="Upload a PDF and the agent can search it with search_docs — or drop one anywhere on this page."
          action={
            <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
              <UploadIcon data-icon="inline-start" />
              {busy ? 'Indexing…' : 'Upload PDFs'}
            </Button>
          }
        />
      )}
    </div>
  )
}

function DocumentItem({ doc, onRemove }: { doc: DocumentRow; onRemove: () => void }) {
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
            ? 'no text layer, needs OCR'
            : 'could not be read'
          : `${doc.pages}p · ${doc.chunkCount} chunks${partial ? ' · partial' : ''}`
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={`Remove ${doc.title}`}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon />
        </Button>
      }
    />
  )
}
