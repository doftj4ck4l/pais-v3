import type { Item } from '@/shared/lib/types'
import type { TranslationKey } from '@/shared/lib/i18n'

export type LiveRunStatusKey = Extract<
  TranslationKey,
  | 'runConnecting'
  | 'runThinking'
  | 'runAnswering'
  | 'runWaiting'
  | 'runSearchingDocs'
  | 'runSearchingWeb'
  | 'runReading'
  | 'runWriting'
  | 'runRunningCommand'
  | 'runCreating'
  | 'runCheckingData'
  | 'runCheckingCalendar'
  | 'runUsingConnector'
  | 'runUsingTool'
  | 'runReadingName'
  | 'runWritingName'
  | 'runSharingName'
  | 'runSearchingDocsFor'
  | 'runSearchingWebFor'
  | 'runUsingConnectorName'
  | 'runConnectorSearching'
  | 'runConnectorSearchingOnly'
  | 'runConnectorReading'
  | 'runConnectorReadingOnly'
  | 'runConnectorWriting'
  | 'runConnectorWritingOnly'
>

export type LiveStatus = {
  key: LiveRunStatusKey
  values?: Record<string, string>
}

/**
 * Turn the latest stream event into one short, honest status line.
 *
 * Completed tools are skipped: once a result arrives the model is considering
 * it, unless another parallel call is still open. This keeps the UI aligned
 * with the actual run rather than cycling through decorative timer messages.
 */
export function liveRunStatus(items: Item[], waitingForUser = false): LiveStatus {
  if (waitingForUser) return { key: 'runWaiting' }
  let passedCompletedTool = false

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item.kind === 'tool') {
      if (item.result === undefined) return toolStatus(item.name, item.args)
      passedCompletedTool = true
      continue
    }

    // Text before a completed call belongs to the previous phase; the model is
    // now considering the result, not still composing that earlier sentence.
    if (item.kind === 'assistant') {
      return { key: passedCompletedTool ? 'runThinking' : 'runAnswering' }
    }
    if (item.kind === 'thinking' || item.kind === 'iteration') return { key: 'runThinking' }

    // A user message with no stream event after it is still being handed to
    // the runtime (including sandbox acquisition).
    if (item.kind === 'user') {
      return { key: passedCompletedTool ? 'runThinking' : 'runConnecting' }
    }
  }

  return { key: passedCompletedTool ? 'runThinking' : 'runConnecting' }
}

const PATH_ARGUMENTS = ['path', 'file', 'filepath', 'filename', 'target', 'source']
const QUERY_ARGUMENTS = ['query', 'q', 'search', 'pattern']

/**
 * Name both the action and its subject when the tool call exposes one. The UI
 * should answer “what is Pi doing?” rather than merely restating the spinner.
 */
export function toolStatus(toolName: string, args?: string): LiveStatus {
  const name = toolName.toLowerCase()
  const parsed = parseArgs(args)

  if (name === 'ask_user') return { key: 'runWaiting' }
  if (name === 'search_docs') {
    const query = stringArg(parsed, QUERY_ARGUMENTS)
    return query
      ? { key: 'runSearchingDocsFor', values: { name: shorten(query) } }
      : { key: 'runSearchingDocs' }
  }
  if (name === 'web_search') {
    const query = stringArg(parsed, QUERY_ARGUMENTS)
    return query
      ? { key: 'runSearchingWebFor', values: { name: shorten(query) } }
      : { key: 'runSearchingWeb' }
  }
  if (name === 'fetch_url') {
    const url = stringArg(parsed, ['url'])
    return url
      ? { key: 'runReadingName', values: { name: shorten(hostOf(url)) } }
      : { key: 'runSearchingWeb' }
  }
  if (
    name === 'search_schema' ||
    name === 'describe_table' ||
    name === 'run_query' ||
    name.includes('tables_')
  ) {
    return { key: 'runCheckingData' }
  }
  if (name.includes('calendar') || name.includes('freebusy')) {
    return { key: 'runCheckingCalendar' }
  }

  // MCP tools are namespaced as server__tool. Describe both halves so the user
  // sees “Searching Nextcloud for X”, not an opaque connector name.
  if (name.includes('__')) {
    const [rawServer = '', rawTool = ''] = toolName.split('__')
    const server = capitalise(rawServer)
    const tool = rawTool.toLowerCase()
    const subject = stringArg(parsed, [
      ...QUERY_ARGUMENTS,
      ...PATH_ARGUMENTS,
      'term',
      'name',
    ])

    if (/search|find|query/.test(tool)) {
      return subject
        ? { key: 'runConnectorSearching', values: { server, name: shorten(subject) } }
        : { key: 'runConnectorSearchingOnly', values: { server } }
    }
    if (/read|download/.test(tool) || tool.startsWith('get_')) {
      return subject
        ? { key: 'runConnectorReading', values: { server, name: shorten(baseName(subject)) } }
        : { key: 'runConnectorReadingOnly', values: { server } }
    }
    if (/write|create|update|upload|put/.test(tool)) {
      return subject
        ? { key: 'runConnectorWriting', values: { server, name: shorten(baseName(subject)) } }
        : { key: 'runConnectorWritingOnly', values: { server } }
    }
    return server
      ? { key: 'runUsingConnectorName', values: { name: server } }
      : { key: 'runUsingConnector' }
  }

  if (name === 'read' || name === 'read_file' || name === 'read_image') {
    const path = stringArg(parsed, PATH_ARGUMENTS)
    return path
      ? { key: 'runReadingName', values: { name: shorten(baseName(path)) } }
      : { key: 'runReading' }
  }
  if (name === 'write' || name === 'edit') {
    const path = stringArg(parsed, PATH_ARGUMENTS)
    return path
      ? { key: 'runWritingName', values: { name: shorten(baseName(path)) } }
      : { key: 'runWriting' }
  }
  if (name === 'share_file') {
    const path = stringArg(parsed, PATH_ARGUMENTS)
    return path
      ? { key: 'runSharingName', values: { name: shorten(baseName(path)) } }
      : { key: 'runWriting' }
  }
  if (name === 'bash') return { key: 'runRunningCommand' }
  if (name === 'generate_image' || name === 'render_ui') return { key: 'runCreating' }
  return { key: 'runUsingTool' }
}

function parseArgs(args?: string): Record<string, unknown> | null {
  if (!args) return null
  try {
    const parsed = JSON.parse(args) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringArg(args: Record<string, unknown> | null, keys: string[]): string | null {
  if (!args) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function capitalise(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

const MAX_SUBJECT = 42

function shorten(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_SUBJECT ? `${oneLine.slice(0, MAX_SUBJECT - 1)}…` : oneLine
}
