import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  SearchIcon,
} from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { PanelEmpty } from '@/features/resources/components/panel-kit'
import { groupByDate } from '@/features/resources/lib/resource-browser'
import { useNavigate } from '@tanstack/react-router'
import { listWorkspaceFiles, workspaceFileUrl } from '@/shared/api/api'
import { useBoard } from '@/features/agents/hooks/use-agent-board'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { usePreferences } from '@/shared/hooks/use-preferences'
import { localeFor } from '@/shared/lib/i18n'
import type { WorkspaceFile } from '@/shared/lib/types'
import { cn } from '@/shared/lib/utils'

type AssetFolder = {
  key: string
  label: string
  rows: WorkspaceFile[]
}

const shortTitle = (title: string) =>
  title.length > 44 ? `${title.slice(0, 44).trimEnd()}…` : title

export function FilesPanel({
  refreshKey,
  onCountChange,
}: {
  refreshKey?: number
  onCountChange?: (n: number) => void
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [busy, setBusy] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [query, setQuery] = useState('')
  const scope = useScope()
  const board = useBoard()
  const navigate = useNavigate()
  const { language, t } = usePreferences()

  const openChat = (conversationId: string) => {
    board.select(conversationId)
    void navigate({ to: '/' })
  }

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setFiles(await listWorkspaceFiles(scope))
    } catch {
      // Keep the last useful file listing through a transient request failure.
    } finally {
      setBusy(false)
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  useEffect(() => onCountChange?.(files.length), [files.length, onCountChange])

  const folders = useMemo(() => assetFolders(files, t('workspaceRoot')), [files, t])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(localeFor(language))
    return files.filter((file) => {
      const folder = topFolder(file.path)
      const inFolder = selectedFolder === 'all' || folder === selectedFolder
      return inFolder && file.path.toLocaleLowerCase(localeFor(language)).includes(needle)
    })
  }, [files, language, query, selectedFolder])
  const groups = useMemo(
    () => groupByDate(filtered, (file) => file.modifiedAt, {
      locale: localeFor(language),
      today: t('today'),
      yesterday: t('yesterday'),
    }),
    [filtered, language, t],
  )
  const selected = files.find((file) => file.path === selectedPath) ?? null

  useEffect(() => {
    if (filtered.length && !filtered.some((file) => file.path === selectedPath)) {
      setSelectedPath(filtered[0]!.path)
    } else if (!filtered.length) {
      setSelectedPath(null)
    }
  }, [filtered, selectedPath])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <AssetToolbar
        query={query}
        onQueryChange={setQuery}
        busy={busy}
        onRefresh={() => void refresh()}
      />

      {files.length ? (
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-y-auto lg:grid-cols-[13rem_minmax(20rem,0.9fr)_minmax(22rem,1.15fr)] lg:overflow-hidden">
          <AssetFolderRail
            folders={folders}
            total={files.length}
            selected={selectedFolder}
            onSelect={setSelectedFolder}
          />
          <AssetList
            groups={groups}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            empty={query ? t('noMatchingAssets') : t('noFiles')}
          />
          <AssetPreview
            file={selected}
            url={selected ? workspaceFileUrl(scope, selected.path) : null}
            onOpenChat={openChat}
          />
        </div>
      ) : (
        <PanelEmpty
          icon={FileIcon}
          title={t('noFiles')}
          description={t('noFilesDescription')}
          className="min-h-0 flex-1 border-t"
        />
      )}
    </div>
  )
}

function AssetToolbar({
  query,
  onQueryChange,
  busy,
  onRefresh,
}: {
  query: string
  onQueryChange: (value: string) => void
  busy: boolean
  onRefresh: () => void
}) {
  const { t } = usePreferences()
  return (
    <header className="flex min-h-14 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2 sm:gap-3 sm:px-4">
      <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-sm font-medium sm:w-auto">
        <FolderOpenIcon className="size-4 fill-blue-500/15 text-blue-500" />
        <span>{t('assets')}</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate text-muted-foreground">{t('allAssets')}</span>
      </div>
      <div className="flex w-full min-w-0 items-center justify-end gap-2 sm:ml-auto sm:w-auto">
        <label className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('searchAssets')}
            aria-label={t('searchAssets')}
            className="h-8 w-full rounded-lg border bg-background pr-3 pl-8 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-blue-500/25"
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={busy}
          aria-label={t('refreshFiles')}
        >
          <RefreshCwIcon data-icon="inline-start" className={busy ? 'animate-spin' : undefined} />
          <span className="hidden sm:inline">{t('refresh')}</span>
        </Button>
      </div>
    </header>
  )
}
function AssetFolderRail({
  folders,
  total,
  selected,
  onSelect,
}: {
  folders: AssetFolder[]
  total: number
  selected: string
  onSelect: (key: string) => void
}) {
  const { t } = usePreferences()
  const items = [
    { key: 'all', label: t('allAssets'), count: total },
    ...folders.map((folder) => ({ key: folder.key, label: folder.label, count: folder.rows.length })),
  ]

  return (
    <aside className="border-b bg-muted/25 p-2 lg:border-r lg:border-b-0" aria-label={t('assetFolders')}>
      <p className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t('assetFolders')}
      </p>
      <div className="scrollbar-subtle flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {items.map((item) => {
          const active = selected === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSelect(item.key)}
              className={cn(
                'flex h-9 min-w-fit items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors lg:w-full',
                active ? 'bg-blue-500 text-white shadow-sm' : 'hover:bg-foreground/5',
              )}
            >
              {item.key === 'all' ? (
                <FolderOpenIcon className="size-4 shrink-0" />
              ) : (
                <FolderIcon className={cn('size-4 shrink-0', !active && 'fill-blue-500/15 text-blue-500')} />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className={cn('readout text-[10px]', active ? 'text-white/75' : 'text-muted-foreground')}>
                {item.count}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function AssetList({
  groups,
  selectedPath,
  onSelect,
  empty,
}: {
  groups: ReturnType<typeof groupByDate<WorkspaceFile>>
  selectedPath: string | null
  onSelect: (path: string) => void
  empty: string
}) {
  const { language, t } = usePreferences()
  if (!groups.length) {
    return <div className="flex min-h-48 items-center justify-center border-b px-6 text-center text-sm text-muted-foreground lg:border-r lg:border-b-0">{empty}</div>
  }

  return (
    <section className="min-h-0 min-w-0 overflow-y-auto border-b lg:border-r lg:border-b-0" aria-label={t('allAssets')}>
      <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_6.5rem_5rem] border-b bg-card/95 px-3 py-2 text-[11px] font-medium text-muted-foreground backdrop-blur-sm sm:grid">
        <span>{t('name')}</span><span>{t('modified')}</span><span>{t('size')}</span>
      </div>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="sticky top-0 z-[5] flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground backdrop-blur-sm sm:top-[33px]">
            <FolderIcon className="size-3.5 fill-blue-500/15 text-blue-500" />
            <span>{group.label}</span>
            <span className="font-normal">{group.rows.length}</span>
          </div>
          <ul>
            {group.rows.map((file) => {
              const active = file.path === selectedPath
              return (
                <li key={file.path} className={cn('border-b last:border-b-0', active && 'bg-blue-500 text-white')}>
                  <button
                    type="button"
                    onClick={() => onSelect(file.path)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300 sm:grid-cols-[minmax(0,1fr)_6.5rem_5rem]"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FileIcon className={cn('size-4 shrink-0', active ? 'text-white' : 'text-blue-500')} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{fileName(file.path)}</span>
                        <span className={cn('mt-0.5 block truncate text-[11px]', active ? 'text-white/75' : 'text-muted-foreground')}>
                          {fileDirectory(file.path) || t('workspaceRoot')}
                        </span>
                      </span>
                    </span>
                    <span className={cn('readout hidden text-[11px] sm:block', active ? 'text-white/75' : 'text-muted-foreground')}>
                      {new Intl.DateTimeFormat(localeFor(language), { hour: '2-digit', minute: '2-digit' }).format(file.modifiedAt)}
                    </span>
                    <span className={cn('readout hidden text-[11px] sm:block', active ? 'text-white/75' : 'text-muted-foreground')}>
                      {formatBytes(file.bytes)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}

function AssetPreview({
  file,
  url,
  onOpenChat,
}: {
  file: WorkspaceFile | null
  url: string | null
  onOpenChat: (conversationId: string) => void
}) {
  const { language, t } = usePreferences()
  if (!file) {
    return (
      <section className="flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <FileIcon className="size-8 stroke-[1.4]" />
        <p className="max-w-xs text-sm leading-relaxed">{t('selectAsset')}</p>
      </section>
    )
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background" aria-label={t('assetPreview')}>
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
          <FileIcon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{fileName(file.path)}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{file.path}</p>
        </div>
        {url ? (
          <Button variant="ghost" size="icon-sm" aria-label={t('downloadFile', { name: file.path })} asChild>
            <a href={url} download><DownloadIcon /></a>
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-8 py-10 text-center">
        <span className="flex size-20 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <FileIcon className="size-9 stroke-[1.25]" />
        </span>
        <div>
          <p className="text-sm font-medium">{fileName(file.path)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('assetReady')}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {url ? (
            <Button size="sm" asChild>
              <a href={url} download>
                <DownloadIcon data-icon="inline-start" />
                {t('download')}
              </a>
            </Button>
          ) : null}
          {file.origin ? (
            <Button variant="outline" size="sm" onClick={() => onOpenChat(file.origin!.conversationId)}>
              <MessageSquareTextIcon data-icon="inline-start" />
              {t('openSourceChat')}
            </Button>
          ) : null}
        </div>
      </div>

      <footer className="grid grid-cols-2 gap-3 border-t bg-muted/20 px-4 py-3 text-xs sm:grid-cols-3">
        <Metadata label={t('size')} value={formatBytes(file.bytes)} />
        <Metadata
          label={t('modified')}
          value={new Intl.DateTimeFormat(localeFor(language), { dateStyle: 'medium', timeStyle: 'short' }).format(file.modifiedAt)}
        />
        <Metadata label={t('source')} value={file.origin ? shortTitle(file.origin.title) : t('workspace')} />
      </footer>
    </section>
  )
}

function assetFolders(files: WorkspaceFile[], rootLabel: string): AssetFolder[] {
  const groups = new Map<string, WorkspaceFile[]>()
  for (const file of files) {
    const key = topFolder(file.path)
    groups.set(key, [...(groups.get(key) ?? []), file])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === 'root') return -1
      if (b === 'root') return 1
      return a.localeCompare(b)
    })
    .map(([key, rows]) => ({ key, rows, label: key === 'root' ? rootLabel : key }))
}

function topFolder(path: string): string {
  const slash = path.indexOf('/')
  return slash === -1 ? 'root' : path.slice(0, slash)
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

function fileDirectory(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-medium" title={value}>{value}</p></div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}
