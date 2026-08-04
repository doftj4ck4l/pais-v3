import { useCallback, useEffect, useState } from 'react'
import { DownloadIcon, FileIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listWorkspaceFiles, workspaceFileUrl } from '@/lib/api'
import { useScope } from '@/hooks/use-workspace'
import type { WorkspaceFile } from '@/lib/types'

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
      <div className="mb-2 flex items-center gap-2">
        <h2 className="label text-muted-foreground">Files</h2>
        {files.length ? (
          <span className="readout text-[0.625rem] text-muted-foreground">{files.length}</span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="Refresh files"
          className="ml-auto text-muted-foreground"
        >
          <RefreshCwIcon className={busy ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {files.length ? (
        <ul className="flex flex-col gap-0.5">
          {files.map((file) => (
            <li key={file.path}>
              <a
                href={workspaceFileUrl(scope, file.path)}
                download
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{file.path}</span>
                  <span className="readout block text-[0.625rem] text-muted-foreground">
                    {fmtBytes(file.bytes)}
                  </span>
                </span>
                <DownloadIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">
          Nothing yet. Files the agent writes appear here.
        </p>
      )}
    </div>
  )
}
