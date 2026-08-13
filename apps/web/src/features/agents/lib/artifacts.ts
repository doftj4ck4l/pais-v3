import type { Item } from '@/shared/lib/types'

/**
 * What one session produced, read out of its own transcript.
 *
 * The transcript is the source rather than a listing endpoint, and that is the
 * point: images and files live in workspace-wide stores, so asking the server
 * "what is here" answers for every run this workspace has ever had. The
 * question the panel beside a transcript asks is narrower — what did *this*
 * conversation make — and the transcript is the only place that is written
 * down turn by turn. It also arrives live, so a picture appears in the panel
 * the moment the tool call returns, with nothing to poll.
 */
export type SessionArtifacts = {
  /** `/api/images/<id>` URLs, oldest first. Generated, shared, and pasted alike. */
  images: string[]
  /** Workspace-relative paths the run wrote or shared, oldest first. */
  files: string[]
}

/**
 * A value that changes whenever the transcript's *content* does.
 *
 * Needed because `useAgentBoard` streams into one array and publishes that same
 * array on every flush — the items are mutated in place, so the array's
 * identity is constant for a whole run. Memoising on `items` therefore computes
 * the artifacts once, at mount, and never again: a live run drew nothing in the
 * panel while a reloaded one drew everything, which is exactly how this was
 * found.
 *
 * Lengths rather than a hash: this runs on every render of the chat, and
 * summing three numbers over the transcript is the cheapest thing that still
 * notices a tool result arriving and an answer streaming in.
 */
export function transcriptKey(items: Item[]): string {
  let results = 0
  let text = 0
  for (const item of items) {
    if (item.kind === 'tool') results += item.result?.length ?? 0
    else if (item.kind === 'assistant' || item.kind === 'user') text += item.text.length
  }
  return `${items.length}:${results}:${text}`
}

/** `/api/images/<id>` anywhere in prose — markdown, a bare URL, a tool result. */
const IMAGE_URL = /\/api\/images\/([A-Za-z0-9._-]+)/g

/**
 * `/api/workspace/files/<path>` — what `share_file` hands back for anything
 * that is not an image. The query string is dropped: the panel builds its own
 * download URL from the current workspace scope.
 */
const FILE_URL = /\/api\/workspace\/files\/([^\s)"'<>]+)/g

/** Tools whose call means a file now exists at the path in their arguments. */
const WROTE_A_FILE = /^(write|create_file|put_|edit|patch|replace|update_|share_file)/

export function sessionArtifacts(items: Item[]): SessionArtifacts {
  const images = new Set<string>()
  const files = new Set<string>()

  const scan = (text: string | undefined) => {
    if (!text) return
    for (const [, id] of text.matchAll(IMAGE_URL)) images.add(`/api/images/${id}`)
    for (const [, encoded] of text.matchAll(FILE_URL)) {
      const path = decodePath(encoded.split('?')[0] ?? '')
      if (path) files.add(path)
    }
  }

  for (const item of items) {
    if (item.kind === 'user') {
      // A live turn carries the URLs as a field and a stored one carries them
      // in the note the server appended, so both paths are read.
      for (const url of item.images ?? []) images.add(url)
      scan(item.text)
      continue
    }
    if (item.kind === 'assistant') {
      scan(item.text)
      continue
    }
    if (item.kind !== 'tool') continue

    scan(item.result)
    // A tool that wrote a file names it in its arguments. `bash` can create one
    // without ever saying so, which is why `share_file` exists — a file the
    // user is meant to have is a file the agent was told to hand over.
    const verb = item.name.split('__').pop() ?? item.name
    if (item.ok !== false && WROTE_A_FILE.test(verb)) {
      const path = argPath(item.args)
      if (path) files.add(path)
    }
  }

  return { images: [...images], files: [...files] }
}

/** The written path, normalised to workspace-relative — never a leading `/`. */
function argPath(argsJson: string): string | null {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return null
  }
  for (const key of ['path', 'file_path', 'filePath', 'file', 'filename', 'target']) {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const written = value.trim()
    if (!written.startsWith('/')) return written

    // The model usually writes the absolute path it was given, which names the
    // sandbox's workspace directory — while the download route addresses files
    // relative to it. The directory is `<something>/ws_<id>/`, so that segment
    // is the seam. A path that has no such segment is not in the workspace and
    // gets no link at all: a download that 404s is worse than an absent row.
    return written.match(/(?:^|\/)ws_[^/]+\/(.+)$/)?.[1] ?? null
  }
  return null
}

/** A malformed percent-encoding is a path to skip, not a crash. */
function decodePath(encoded: string): string | null {
  try {
    return encoded
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return null
  }
}
