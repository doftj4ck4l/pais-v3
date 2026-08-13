import { useCallback, useEffect, useState } from 'react'
import { DownloadIcon, FileIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import { useNavigate } from '@tanstack/react-router'
import { listWorkspaceFiles, workspaceFileUrl } from '@/shared/api/api'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { WorkspaceFile } from '@/shared/lib/types'

/**
 * A chat's title is its whole first prompt, which can be a paragraph. Cut to
 * the first clause: the line is provenance, not a summary, and the full text is
 * on the button's tooltip.
 */
const shortTitle = (title: string) =>
  title.length > 44 ? `${title.slice(0, 44).trimEnd()}…` : title

const fmtBytes = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : n >= 1000 ? `${Math.round(n / 1000)}KB` : `${n}B`

/**
 * Everything the agent has produced in its sandbox workspace.
 *
 * Without this the agent can write a spreadsheet and report success while the
 * file stays unreachable inside the container's workspace. Refresh is manual:
 * files appear as a side effect of a run, and polling a filesystem to catch
 * that is more machinery than the payoff justifies.
 */
export function FilesPanel({
  refreshKey,
  onCountChange,
}: {
  refreshKey?: number
  onCountChange?: (n: number) => void
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [busy, setBusy] = useState(false)
  const scope = useScope()
  const board = useBoard()
  const navigate = useNavigate()

  // Same move as the sidebar's run list: choosing a chat has to navigate as
  // well as select, or it would change what an invisible page is showing.
  const openChat = (conversationId: string) => {
    board.select(conversationId)
    void navigate({ to: '/' })
  }

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setFiles(await listWorkspaceFiles(scope))
    } catch {
      // Panel is secondary to the console; a listing failure is not fatal.
    } finally {
      setBusy(false)
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  useEffect(() => onCountChange?.(files.length), [files.length, onCountChange])

  return (
    <div className="flex flex-col">
      <PanelHeader
        summary={files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : null}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy}
            aria-label="Refresh files"
          >
            <RefreshCwIcon data-icon="inline-start" className={busy ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        }
      />

      {files.length ? (
        <PanelGrid>
          {files.map((file) => (
            <ItemCard
              key={file.path}
              href={workspaceFileUrl(scope, file.path)}
              download
              label={`Download ${file.path}`}
              leading={<FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              title={file.path}
              meta={
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0">{fmtBytes(file.bytes)}</span>
                  {/*
                    Where it came from, and a way back to it. Above the card's
                    own download overlay (`z-10`), because the two are different
                    intents: the card gets you the bytes, this gets you the work
                    that made them.

                    Absent rather than "unknown" when nothing named the file —
                    see `fileOrigins` on the server. A blank space says "we have
                    nothing to tell you" without dressing it up as a category.
                  */}
                  {file.origin ? (
                    <>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        onClick={() => openChat(file.origin!.conversationId)}
                        title={file.origin.title}
                        className="relative z-10 min-w-0 truncate text-left underline-offset-2 hover:text-foreground hover:underline"
                      >
                        from “{shortTitle(file.origin.title)}”
                      </button>
                    </>
                  ) : null}
                </span>
              }
              actions={<DownloadIcon className="size-4 text-muted-foreground" />}
            />
          ))}
        </PanelGrid>
      ) : (
        <PanelEmpty
          icon={FileIcon}
          title="No files yet"
          description="Anything the agent writes in this workspace — a spreadsheet, a document, a script — lands here to download."
        />
      )}
    </div>
  )
}
