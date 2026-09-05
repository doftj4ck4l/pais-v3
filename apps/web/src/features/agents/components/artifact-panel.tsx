import { DownloadIcon, FileIcon, XIcon } from 'lucide-react'
import { workspaceFileUrl } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { cn } from '@/shared/lib/utils'
import type { SessionArtifactState } from '@/features/agents/hooks/use-session-artifacts'
import { usePreferences } from '@/shared/hooks/use-preferences'

const fmtBytes = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : n >= 1000 ? `${Math.round(n / 1000)}KB` : `${n}B`

/**
 * What this chat made, beside the chat that made it.
 *
 * A column rather than a page: a file the agent produced is part of the answer,
 * and an answer split across two navigations is two things to hold in your
 * head. The Files page still lists the workspace as a whole — this is the same
 * bytes, narrowed to the conversation you are reading and put where you were
 * already looking.
 *
 * It draws what `useSessionArtifacts` decided and nothing else, so the count in
 * the header and the contents here are the same value.
 */
export function ArtifactPanel({
  artifacts,
  onClose,
}: {
  artifacts: SessionArtifactState
  onClose: () => void
}) {
  const scope = useScope()
  const { images, files } = artifacts
  const { t } = usePreferences()

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">
          {t('filesInChat')}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{artifacts.count || ''}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeFilesPanel')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <XIcon className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!artifacts.count ? (
          <p className="px-1 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {t('filesEmpty')}
          </p>
        ) : null}

        {images.length ? (
          <div className="grid grid-cols-2 gap-2">
            {images.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  'block overflow-hidden rounded-md border bg-muted/40',
                  'transition-colors hover:border-foreground/30',
                )}
              >
                <img
                  src={url}
                  alt={t('madeInChat')}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              </a>
            ))}
          </div>
        ) : null}

        {files.length ? (
          <div className={cn('flex flex-col gap-1', images.length && 'mt-3')}>
            {files.map((file) => (
              <a
                key={file.path}
                href={workspaceFileUrl(scope, file.path)}
                download
                aria-label={t('downloadFile', { name: file.path })}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left',
                  'transition-colors hover:bg-accent',
                )}
              >
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] leading-tight font-medium">
                    {file.path.split('/').pop()}
                  </span>
                  {file.bytes !== undefined ? (
                    <span className="text-[0.6875rem] text-muted-foreground">
                      {fmtBytes(file.bytes)}
                    </span>
                  ) : null}
                </span>
                <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
