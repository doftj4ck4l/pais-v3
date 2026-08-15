import {
  BookmarkIcon,
  BrainIcon,
  ClockIcon,
  CloudSunIcon,
  DatabaseIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  MessageSquareIcon,
  PencilLineIcon,
  ShareIcon,
  SigmaIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * How one tool call reads in the transcript.
 *
 * A raw call — `nc_webdav_list_directory {"path":"/Shared"}` — says what the
 * runtime did, not what the agent was doing. The transcript is read by someone
 * following the work, so each call is phrased as an action: past tense once it
 * has returned, present tense while it is still running.
 */
export type ToolSummary = {
  Icon: LucideIcon
  /** `Searched "moai statues"` — shown once the result is in. */
  done: string
  /** `Searching for "moai statues"` — shown while the call is in flight. */
  running: string
}

export function describeTool(name: string, argsJson: string): ToolSummary {
  const args = parseArgs(argsJson)
  const query = pick(args, ['query', 'q', 'search', 'keyword', 'question'])
  const path = pick(args, ['path', 'file', 'file_path', 'filePath', 'filename', 'target'])
  const url = pick(args, ['url', 'uri', 'href', 'link'])
  const command = pick(args, ['command', 'cmd', 'script'])

  // Matched on the last segment: an MCP tool arrives as `server__tool_name`,
  // and the server half says nothing about what the call does.
  const verb = name.split('__').pop() ?? name

  if (/^search_docs|document_search/.test(verb)) {
    return phrase(FileSearchIcon, 'Searched documents', 'Searching documents', quote(query))
  }
  if (/^search_tools/.test(verb)) {
    return phrase(WrenchIcon, 'Looked for tools', 'Looking for tools', quote(query))
  }
  if (/^ask_user/.test(verb)) {
    // The interactive card carries the options; the transcript line just marks
    // that the run paused to ask, with the question itself as the detail.
    return phrase(MessageSquareIcon, 'Asked you', 'Waiting for your answer', quote(query))
  }
  if (/^read_image|describe_image|vision/.test(verb)) {
    return phrase(ImageIcon, 'Read an image', 'Reading the image')
  }
  if (/^share_file/.test(verb)) {
    return phrase(ShareIcon, 'Shared a file', 'Sharing the file', path)
  }
  if (/^generate_image|create_image|image_gen/.test(verb)) {
    return phrase(SparklesIcon, 'Generated an image', 'Generating an image')
  }
  if (/^remember|memori[sz]e|save_memory/.test(verb)) {
    return phrase(BookmarkIcon, 'Saved a memory', 'Saving to memory', quote(query))
  }
  if (/^recall/.test(verb)) {
    return phrase(BrainIcon, 'Recalled memory', 'Searching memory', quote(query))
  }
  if (/^call_skill|run_skill/.test(verb)) {
    const skill = pick(args, ['skill', 'name', 'id'])
    return phrase(SparklesIcon, 'Ran a skill', 'Running a skill', skill)
  }
  if (/^calculator|calculate|math/.test(verb)) {
    return phrase(SigmaIcon, 'Calculated', 'Calculating', pick(args, ['expression', 'expr', 'input']))
  }
  if (/^get_current_time|^current_time|^time$|^now$/.test(verb)) {
    return phrase(ClockIcon, 'Checked the time', 'Checking the time')
  }
  if (/^get_weather|^weather/.test(verb)) {
    const place = pick(args, ['location', 'city', 'place'])
    return phrase(CloudSunIcon, 'Checked the weather', 'Checking the weather', place && `in ${place}`)
  }
  if (/sql|query|database|^db_/.test(verb)) {
    return phrase(DatabaseIcon, 'Queried the database', 'Querying the database')
  }
  if (/^bash|shell|exec|^run_/.test(verb)) {
    return phrase(SquareTerminalIcon, 'Ran a command', 'Running a command', code(command))
  }
  if (/^write|create_file|put_/.test(verb)) {
    return phrase(FilePlusIcon, 'Wrote', 'Writing', basename(path) ?? 'a file')
  }
  if (/^edit|patch|replace|update_/.test(verb)) {
    return phrase(PencilLineIcon, 'Edited', 'Editing', basename(path) ?? 'a file')
  }
  if (/^read|^cat|^view|^get_file|^open/.test(verb)) {
    return phrase(FileTextIcon, 'Read', 'Reading', basename(path) ?? 'a file')
  }
  if (/^fetch|http|browse|crawl|scrape/.test(verb)) {
    return phrase(GlobeIcon, 'Fetched', 'Fetching', host(url))
  }
  // Generic search last: it is the loosest match, so anything more specific
  // above has to have had its chance first.
  if (/search|find|grep|lookup|list/.test(verb) || query) {
    return phrase(GlobeIcon, 'Searched', 'Searching for', quote(query) ?? readable(verb))
  }

  const detail = quote(query) ?? basename(path) ?? host(url) ?? code(command)
  // `Called get current time`, not `Used …`: the line already opens with
  // "Used tool:", and "Used tool: Used get current time" reads as a stutter.
  return phrase(WrenchIcon, `Called ${readable(verb)}`, `Calling ${readable(verb)}`, detail)
}

/** `Thought for 6 seconds` — the reasoning block's own cost, in words. */
export function thoughtLabel(ms: number | undefined): string {
  if (ms === undefined) return 'Thought about it'
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `Thought for ${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.floor(seconds / 60)
  return `Thought for ${minutes}m ${seconds % 60}s`
}

function phrase(Icon: LucideIcon, done: string, running: string, detail?: string): ToolSummary {
  return {
    Icon,
    done: detail ? `${done} ${detail}` : done,
    running: detail ? `${running} ${detail}` : running,
  }
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function pick(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Long arguments are cut here rather than by the row, so the ellipsis lands
 *  inside the quotes and the line still reads as a sentence. */
function clamp(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function quote(text: string | undefined): string | undefined {
  return text ? `“${clamp(text)}”` : undefined
}

function code(text: string | undefined): string | undefined {
  return text ? clamp(text, 48) : undefined
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined
  const trimmed = path.replace(/\/+$/, '')
  return clamp(trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed, 40)
}

function host(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return clamp(url, 40)
  }
}

/** `nc_webdav_list_directory` → `nc webdav list directory`. */
function readable(verb: string): string {
  return verb.replace(/[_-]+/g, ' ').trim() || verb
}
