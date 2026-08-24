import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import {
  list as hostList,
  resolve as hostResolve,
  workspaceRoot,
  type WorkspaceFile,
} from "../../repositories/workspace.repository";
import { PixelboxError } from "../sandbox/pixelbox-client";
import { WORKSPACE_PATH, sandboxApi, sandboxService } from "../sandbox/sandbox.service";

/**
 * Read a workspace's files, from wherever they actually live.
 *
 * Under the node backend the files sit on the API host, so `fs` reads them. Under
 * Pixelbox they live in the remote sandbox's NFS volume and the host has nothing
 * — so the same reads have to go through the sandbox's file API. `share_file`,
 * `read_image`, and the Files page all broke on Pixelbox for exactly this reason:
 * they `fs.readFile`'d a host path that no longer held the agent's output, got
 * nothing, and the agent — seeing sharing fail — went hunting for other ways out.
 *
 * The absolute paths handed in here are already confined by
 * `resolveInWorkspace` (host root on node, `/workspace` on Pixelbox), so this
 * module does not re-check them; it only chooses where to read.
 */

const isPixelbox = () => env.sandboxBackend === "pixelbox";

export type WorkspaceStat = { size: number; mtimeMs: number; isFile: boolean };

/** Normalize and confine a caller-supplied workspace-relative path. */
export function normalizeWorkspacePath(relativePath: string): string | null {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (path.isAbsolute(relativePath) || !segments.length || segments.some((segment) => segment === "..")) {
    return null;
  }
  return segments.join("/");
}

/** The absolute path the active execution backend gives to the agent. */
export function absoluteWorkspacePath(workspaceId: string, relativePath: string): string | null {
  const normalized = normalizeWorkspacePath(relativePath);
  if (!normalized) return null;
  return isPixelbox()
    ? `${WORKSPACE_PATH}/${normalized}`
    : path.resolve(workspaceRoot(workspaceId), ...normalized.split("/"));
}

/** Metadata for a confined absolute path, or null when it is absent. */
export async function statInWorkspace(workspaceId: string, absPath: string): Promise<WorkspaceStat | null> {
  if (!isPixelbox()) {
    const stat = await fs.stat(absPath).catch(() => null);
    return stat ? { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() } : null;
  }
  const { sandboxId } = await sandboxService.acquire(workspaceId);
  try {
    const info = await sandboxApi().stat(sandboxId, absPath);
    return info ? { size: info.size, mtimeMs: info.mtimeMs, isFile: info.kind === "file" } : null;
  } catch (e) {
    if (e instanceof PixelboxError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

/** Bytes for a confined absolute path, or null when it is absent. */
export async function readInWorkspace(workspaceId: string, absPath: string): Promise<Uint8Array | null> {
  if (!isPixelbox()) {
    return fs.readFile(absPath).catch(() => null);
  }
  const { sandboxId } = await sandboxService.acquire(workspaceId);
  try {
    return await sandboxApi().readBytes(sandboxId, absPath);
  } catch (e) {
    if (e instanceof PixelboxError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

/**
 * Write bytes to a relative path inside one workspace.
 *
 * Upload callers provide a relative path rather than an absolute one so the
 * backend boundary stays here. Pixelbox always addresses `/workspace`; the
 * node backend addresses this workspace's configured host root. Traversal is
 * rejected before either filesystem sees it.
 */
export async function writeWorkspaceFile(
  workspaceId: string,
  relativePath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const normalized = normalizeWorkspacePath(relativePath);
  const target = absoluteWorkspacePath(workspaceId, relativePath);
  if (!normalized || !target) throw new Error("invalid workspace path");
  const segments = normalized.split("/");

  if (!isPixelbox()) {
    if (segments.length !== 1) throw new Error("invalid workspace path");
    const root = workspaceRoot(workspaceId);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("invalid workspace path");
    await ensureHostDirectories(root, segments.slice(0, -1));
    await fs.writeFile(target, bytes, { flag: "wx", signal });
    return;
  }

  const { sandboxId } = await sandboxService.acquire(workspaceId);
  const deadline = AbortSignal.timeout(60_000);
  const uploadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  await sandboxApi().createDir(sandboxId, path.posix.dirname(target), true, uploadSignal);
  await sandboxApi().writeBytes(sandboxId, target, bytes, uploadSignal);
}

/** Create child directories without following a workspace-controlled symlink. */
async function ensureHostDirectories(root: string, segments: string[]): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid workspace path");
  }
}

/** Whether a relative path names a real, confined file in this workspace. */
export async function workspaceFileExists(workspaceId: string, relativePath: string): Promise<boolean> {
  const normalized = normalizeWorkspacePath(relativePath);
  const absolutePath = absoluteWorkspacePath(workspaceId, relativePath);
  if (!normalized || !absolutePath) return false;
  if (!isPixelbox()) return (await hostResolve(workspaceId, normalized)).ok;
  const stat = await statInWorkspace(workspaceId, absolutePath);
  return stat?.isFile === true;
}

/**
 * Every file in the workspace, newest first — for the Files page.
 *
 * On Pixelbox a single `find` is one round trip where a recursive walk over the
 * file API would be dozens. Dot-directories are excluded: the workspace's NFS
 * volume also holds `.local` (the warm sandbox's Python user site) and
 * `.pixelspace` (bootstrap metadata and spilled tool output), and neither is the
 * agent's work product.
 */
export async function listWorkspaceFiles(workspaceId: string, limit = 200): Promise<WorkspaceFile[]> {
  if (!isPixelbox()) return hostList(workspaceId, limit);

  const { sandboxId } = await sandboxService.acquire(workspaceId);
  const result = await sandboxApi().execute(sandboxId, {
    command: `find ${WORKSPACE_PATH} -maxdepth 6 -type f -not -path '*/.*' -printf '%P\\t%s\\t%T@\\n' 2>/dev/null | head -n ${limit}`,
    cwd: WORKSPACE_PATH,
    timeoutSeconds: 30,
  });
  const files: WorkspaceFile[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [rel, size, mtime] = line.split("\t");
    if (!rel) continue;
    files.push({ path: rel, bytes: Number(size) || 0, modifiedAt: Math.round((Number(mtime) || 0) * 1000) });
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
