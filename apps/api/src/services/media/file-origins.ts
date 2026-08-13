import path from "node:path";
import { conversationRepository } from "../../repositories/conversation.repository";

/**
 * Which chat produced which file.
 *
 * A file on disk carries no session — the workspace directory is shared by
 * every run — so the only honest source is the transcript: a path a tool was
 * asked to write, edit or share is a path that chat is responsible for. Time is
 * deliberately not used. Two agents can run against one workspace at once, and
 * a file's mtime cannot tell them apart; a label that is wrong is worse on this
 * page than no label, because the whole point of it is to answer "where did
 * this come from".
 *
 * A file nothing named — written by `bash`, or older than the transcripts we
 * keep — gets no origin, and the page shows none. That is the honest answer.
 */
export type FileOrigin = { conversationId: string; title: string };

/** The tools whose arguments name a file they are about to create or change. */
const WROTE_A_FILE = /^(write|create_file|put_|edit|patch|replace|update_|share_file)/;

/** `/api/workspace/files/<path>` — what `share_file` hands back for a download. */
const FILE_URL = /\/api\/workspace\/files\/([^\s)"'<>]+)/g;

/**
 * Workspace-relative path → the most recent chat that wrote it.
 *
 * Most recent rather than first: a file that two chats have edited is, to
 * someone looking at it now, the second one's.
 */
export async function fileOrigins(workspaceId: string): Promise<Map<string, FileOrigin>> {
  const calls = await conversationRepository.listToolCalls(workspaceId);
  const origins = new Map<string, FileOrigin>();

  // Newest first, so the first claim on a path wins and later (older) ones are
  // left alone.
  for (const call of calls) {
    let parsed: { name?: string; args?: Record<string, unknown>; result?: unknown };
    try {
      parsed = JSON.parse(call.text) as typeof parsed;
    } catch {
      continue;
    }

    const origin = { conversationId: call.conversationId, title: call.title };
    const claim = (candidate: string | null) => {
      if (candidate && !origins.has(candidate)) origins.set(candidate, origin);
    };

    const verb = (parsed.name ?? "").split("__").pop() ?? "";
    if (WROTE_A_FILE.test(verb)) claim(relativePath(parsed.args));

    // `share_file` answers with the download URL, which names the path exactly
    // as the listing does — no un-prefixing needed, and no guessing.
    const result = typeof parsed.result === "string" ? parsed.result : "";
    for (const [, encoded] of result.matchAll(FILE_URL)) {
      claim(decodePath((encoded.split("?")[0] ?? "").trim()));
    }
  }

  return origins;
}

/** The written path, as the download route addresses it. */
function relativePath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["path", "file_path", "filePath", "file", "filename", "target"]) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const written = value.trim();
    if (!path.isAbsolute(written)) return written;

    // The model writes the absolute path it was given, which names the sandbox
    // workspace directory; the listing is relative to it. `ws_<id>` is the seam
    // between the two, and a path without one is not in any workspace.
    return written.match(/(?:^|\/)ws_[^/]+\/(.+)$/)?.[1] ?? null;
  }
  return null;
}

/** A malformed percent-encoding is a path to skip, not a throw. */
function decodePath(encoded: string): string | null {
  try {
    return encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}
