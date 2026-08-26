import type { Context } from "hono";
import path from "node:path";
import { env } from "../config/env";
import { resolve } from "../repositories/workspace.repository";
import { fileOrigins } from "../services/media/file-origins";
import {
  absoluteWorkspacePath,
  listWorkspaceFiles,
  normalizeWorkspacePath,
  readInWorkspace,
} from "../services/media/workspace-io";
import { MAX_DATA_FILE_BYTES, storeWorkspaceUpload } from "../services/media/workspace-upload";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { currentUserId } from "../middleware/auth";

/**
 * The workspace whose files this request reads. `resolve` is the one place a
 * client-supplied workspace id is checked against ownership — and here it also
 * decides which directory under SANDBOX_ROOT is reachable at all.
 */
const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/**
 * GET /api/workspace/files — what the agent has produced, newest first.
 *
 * Each file carries the chat that wrote it where a transcript says so. The
 * origins are looked up once for the whole listing rather than per file, and a
 * failure to find one is not an error: most of a long-lived workspace predates
 * anything that named it.
 */
export async function index(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const [files, origins] = await Promise.all([listWorkspaceFiles(workspaceId), fileOrigins(workspaceId)]);
  return c.json({
    files: files.map((file) => ({ ...file, origin: origins.get(file.path) ?? null })),
  });
}

export async function create(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a multipart/form-data body" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file supplied under the 'file' field" }, 400);
  }
  if (file.size > MAX_DATA_FILE_BYTES) {
    return c.json(
      { error: `The attached file is ${(file.size / 1_000_000).toFixed(1)}MB, over the 25MB limit.` },
      413,
    );
  }

  try {
    const result = await storeWorkspaceUpload({
      workspaceId,
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      signal: c.req.raw.signal,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ file: result.file }, 201);
  } catch (error) {
    return c.json({ error: `Could not store the attached file: ${(error as Error).message}` }, 502);
  }
}

/**
 * GET /api/workspace/files/* — download one file.
 *
 * Always served as an attachment. These bytes were written by an agent, so
 * rendering an .html or .svg inline would execute attacker-influenced content
 * on the console's own origin.
 */
export async function show(c: Context) {
  const requested = c.req.path.split("/api/workspace/files/")[1] ?? "";
  const decoded = safeDecode(requested);
  if (decoded === null) return c.json({ error: "File not found" }, 404);

  const workspaceId = await workspaceIdOf(c);

  // Where a confined path resolves, and what to name the download, differ by
  // backend: the node backend resolves against the host filesystem (with symlink
  // checks); Pixelbox has no host copy, so the path is confined textually and
  // read through the sandbox. Rejected and missing are one response either way,
  // so the endpoint cannot be used to map a filesystem.
  let absPath: string;
  let name: string;
  if (env.sandboxBackend === "pixelbox") {
    const sandboxPath = absoluteWorkspacePath(workspaceId, decoded);
    const normalized = normalizeWorkspacePath(decoded);
    if (!sandboxPath || !normalized) return c.json({ error: "File not found" }, 404);
    absPath = sandboxPath;
    name = path.posix.basename(normalized);
  } else {
    const found = await resolve(workspaceId, decoded);
    if (!found.ok) return c.json({ error: "File not found" }, 404);
    absPath = found.absolutePath;
    name = path.basename(found.absolutePath);
  }

  const body = await readInWorkspace(workspaceId, absPath);
  if (!body) return c.json({ error: "File not found" }, 404);

  return c.body(body as unknown as ArrayBuffer, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${quoted(name)}"`,
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
  });
}

/** A malformed percent-encoding is a rejected path, not a 500. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Strip what would break out of the quoted filename in the header. */
function quoted(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}
