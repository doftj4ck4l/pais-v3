import { useCallback, useEffect, useState } from 'react'
import { DownloadIcon, FileIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { ItemCard, PanelEmpty, PanelGrid, PanelHeader } from '@/features/resources/components/panel-kit'
import { listWorkspaceFiles, workspaceFileUrl } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import type { WorkspaceFile } from '@/shared/lib/types'

const fmtBytes = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : n >= 1000 ? `${Math.round(n / 1000)}KB` : `${n}B`

/**
 * Files the agent has produced in its sandbox workspace.
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
              meta={fmtBytes(file.bytes)}
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
