import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, FileTextIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { deleteDocument, listDocuments, uploadDocuments } from '@/lib/api'
import { useScope } from '@/hooks/use-workspace'
import type { DocumentRow } from '@/lib/types'
import { cn } from '@/lib/utils'

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
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="label text-muted-foreground">Context</h2>
        {indexed.length ? (
          <span className="readout text-[0.625rem] text-muted-foreground">
            {indexed.length} doc{indexed.length === 1 ? '' : 's'} · {chunkTotal} chunks
          </span>
        ) : null}
        {busy ? <Spinner className="ml-auto size-3.5 text-muted-foreground" /> : null}
      </div>

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

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
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
        disabled={busy}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2.5',
          'text-xs text-muted-foreground transition-colors',
          'hover:border-foreground/30 hover:text-foreground disabled:opacity-60',
          dragging && 'border-foreground/40 bg-accent text-foreground',
        )}
      >
        <UploadIcon className="size-3.5" />
        {busy ? 'Indexing…' : 'Drop PDFs or click to upload'}
      </button>

      {docs.length ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {docs.map((doc) => (
            <DocumentItem key={doc.id} doc={doc} onRemove={() => void remove(doc.id)} />
          ))}
        </ul>
      ) : null}
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
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      {failed || partial ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{doc.error ?? doc.status}</TooltipContent>
        </Tooltip>
      ) : (
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}

      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-xs', failed && 'text-muted-foreground')}>
          {doc.title}
        </span>
        <span className="readout block text-[0.625rem] text-muted-foreground">
          {failed
            ? doc.status === 'empty'
              ? 'no text layer — needs OCR'
              : 'could not be read'
            : `${doc.pages}p · ${doc.chunkCount} chunks${partial ? ' · partial' : ''}`}
        </span>
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label={`Remove ${doc.title}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2Icon />
      </Button>
    </li>
  )
}
