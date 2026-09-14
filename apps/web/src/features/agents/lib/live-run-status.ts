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
>

/**
 * Turn the latest stream event into one short, honest status line.
 *
 * Completed tools are skipped: once a result arrives the model is considering
 * it, unless another parallel call is still open. This keeps the UI aligned
 * with the actual run rather than cycling through decorative timer messages.
 */
export function liveRunStatus(items: Item[], waitingForUser = false): LiveRunStatusKey {
  if (waitingForUser) return 'runWaiting'
  let passedCompletedTool = false

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item.kind === 'tool') {
      if (item.result === undefined) return toolStatus(item.name)
      passedCompletedTool = true
      continue
    }

    // Text before a completed call belongs to the previous phase; the model is
    // now considering the result, not still composing that earlier sentence.
    if (item.kind === 'assistant') return passedCompletedTool ? 'runThinking' : 'runAnswering'
    if (item.kind === 'thinking' || item.kind === 'iteration') return 'runThinking'

    // A user message with no stream event after it is still being handed to
    // the runtime (including sandbox acquisition).
    if (item.kind === 'user') return passedCompletedTool ? 'runThinking' : 'runConnecting'
  }

  return passedCompletedTool ? 'runThinking' : 'runConnecting'
}

export function toolStatus(toolName: string): LiveRunStatusKey {
  const name = toolName.toLowerCase()

  if (name === 'ask_user') return 'runWaiting'
  if (name === 'search_docs') return 'runSearchingDocs'
  if (name === 'web_search' || name === 'fetch_url') return 'runSearchingWeb'
  if (name === 'bash') return 'runRunningCommand'
  if (name === 'generate_image' || name === 'render_ui') return 'runCreating'

  if (
    name === 'search_schema' ||
    name === 'describe_table' ||
    name === 'run_query' ||
    name.includes('tables_')
  ) {
    return 'runCheckingData'
  }

  if (name.includes('calendar') || name.includes('freebusy')) return 'runCheckingCalendar'

  if (
    name === 'read' ||
    name === 'read_file' ||
    name === 'read_image' ||
    name.endsWith('_read_file')
  ) {
    return 'runReading'
  }

  if (
    name === 'write' ||
    name === 'edit' ||
    name === 'share_file' ||
    name.endsWith('_write_file')
  ) {
    return 'runWriting'
  }

  if (name.includes('__')) return 'runUsingConnector'
  return 'runUsingTool'
}
