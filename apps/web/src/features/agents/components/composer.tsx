import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, ImageIcon, XIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'
import { Spinner } from '@/shared/ui/spinner'
import { uploadChatImage } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { UploadedImage } from '@/shared/lib/types'

/**
 * Starts a new agent. It is never bound to a running agent — stopping one
 * happens on that agent's own header.
 *
 * Images are uploaded on paste rather than on send, so the thumbnail appears
 * while the user is still typing the question and the send request carries an
 * id instead of a megabyte of base64.
 */
export function Composer({
  notice,
  onDismissNotice,
  onSend,
}: {
  notice: string | null
  onDismissNotice: () => void
  onSend: (text: string, images: UploadedImage[]) => void
}) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const scope = useScope()

  // Grow with the prompt, up to a ceiling.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const attach = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setError(null)
      setUploading((n) => n + files.length)
      for (const file of files) {
        try {
          const uploaded = await uploadChatImage(scope, file)
          setImages((prev) => [...prev, uploaded])
        } catch (e) {
          // The API's message names the actual problem ("image is 20MB, over
          // the 12MB limit"), which is worth more than "upload failed".
          setError((e as Error).message)
        } finally {
          setUploading((n) => n - 1)
        }
      }
    },
    [scope],
  )

  const submit = () => {
    // An image with no question is still a message — "what is this?" is the
    // obvious intent, and refusing to send would be pedantic. But an empty
    // composer with nothing attached is not.
    if (!value.trim() && !images.length) return
    if (uploading > 0) return
    onSend(value.trim() || 'What is in this image?', images)
    setValue('')
    setImages([])
    setError(null)
  }

  return (
    <div className="border-t bg-background">
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
            Dismiss
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
          {images.length || uploading > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              {images.map((image) => (
                <Thumbnail
                  key={image.id}
                  image={image}
                  onRemove={() => setImages((prev) => prev.filter((i) => i.id !== image.id))}
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
              className="readout shrink-0 pb-2.5 leading-none text-muted-foreground select-none"
            >
              →
            </span>

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
                void attach(files)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                  f.type.startsWith('image/'),
                )
                if (!files.length) return
                e.preventDefault()
                void attach(files)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={images.length ? 'Ask about the image…' : 'Ask anything…'}
              aria-label="Start a new agent"
              className="max-h-[200px] min-h-0 resize-none border-0 bg-transparent px-0 py-2 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />

            <Button type="submit" disabled={(!value.trim() && !images.length) || uploading > 0}>
              Send
              <ArrowUpIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>

        <p className="mt-1.5 flex items-center gap-1.5 px-1 text-[0.6875rem] text-muted-foreground">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <>
              <ImageIcon className="size-3" />
              Paste or drop an image to ask about it
            </>
          )}
        </p>
      </form>
    </div>
  )
}

function Thumbnail({ image, onRemove }: { image: UploadedImage; onRemove: () => void }) {
  return (
    <span className="group relative block size-14 overflow-hidden rounded-md border">
      <img src={image.url} alt={image.name} className="size-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${image.name}`}
        className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-background/90 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  )
}
