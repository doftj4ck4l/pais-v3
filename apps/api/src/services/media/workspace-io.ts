import fs from "node:fs/promises";
import path from "node:path";
import {
  list as hostList,
  resolve as hostResolve,
  workspaceRoot,
  type WorkspaceFile,
} from "../../repositories/workspace.repository";

/**
 * Workspace files live on the API host and are bind-mounted into Docker
 * sandboxes at the same absolute path. Media and upload callers can therefore
 * use one confined host path for both sides of the boundary.
 */

export type WorkspaceStat = { size: number; mtimeMs: number; isFile: boolean };

/** Normalize and confine a caller-supplied workspace-relative path. */
export function normalizeWorkspacePath(relativePath: string): string | null {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (path.isAbsolute(relativePath) || !segments.length || segments.some((segment) => segment === "..")) {
    return null;
  }
  return segments.join("/");
}

/** The absolute host path bind-mounted into the Docker sandbox. */
export function absoluteWorkspacePath(workspaceId: string, relativePath: string): string | null {
  const normalized = normalizeWorkspacePath(relativePath);
  if (!normalized) return null;
  return path.resolve(workspaceRoot(workspaceId), ...normalized.split("/"));
}

/** Metadata for a confined absolute path, or null when it is absent. */
export async function statInWorkspace(_workspaceId: string, absPath: string): Promise<WorkspaceStat | null> {
  const stat = await fs.stat(absPath).catch(() => null);
  return stat ? { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() } : null;
}

/** Bytes for a confined absolute path, or null when it is absent. */
export async function readInWorkspace(_workspaceId: string, absPath: string): Promise<Uint8Array | null> {
  return fs.readFile(absPath).catch(() => null);
}

/** Write bytes to a relative path inside one workspace. */
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
  if (segments.length !== 1) throw new Error("invalid workspace path");

  const root = workspaceRoot(workspaceId);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("invalid workspace path");
  await ensureHostDirectories(root, segments.slice(0, -1));
  await fs.writeFile(target, bytes, { flag: "wx", signal });
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
  if (!normalized) return false;
  return (await hostResolve(workspaceId, normalized)).ok;
}

/** Every file in the workspace, newest first — for the Files page. */
export async function listWorkspaceFiles(workspaceId: string, limit = 200): Promise<WorkspaceFile[]> {
  return hostList(workspaceId, limit);
}
