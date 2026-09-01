import fs from "node:fs/promises";
import path from "node:path";
import {
  list as hostList,
  resolve as hostResolve,
  workspaceRoot,
  type WorkspaceFile,
} from "../../repositories/workspace.repository";
import { env as appEnv } from "../../config/env";
import { DockerExecutionEnv } from "../sandbox/docker-execution-env";
import { sandboxService } from "../sandbox/sandbox.service";

/**
 * Workspace files live on the API host and are bind-mounted into Docker
 * sandboxes at the same absolute path. Media and upload callers can therefore
 * use one confined host path for both sides of the boundary.
 */

export type WorkspaceStat = { size: number; mtimeMs: number; isFile: boolean };
type WorkspaceReader = Pick<DockerExecutionEnv, "fileInfo" | "readBinaryFile"> & {
  release?: () => Promise<void>;
};
type OpenWorkspace = (workspaceId: string) => Promise<WorkspaceReader>;

const openDockerWorkspace: OpenWorkspace = async (workspaceId) => {
  const sandbox = await sandboxService.acquireLease(workspaceId);
  const reader = new DockerExecutionEnv({ containerId: sandbox.containerId, cwd: sandbox.workspacePath });
  return Object.assign(reader, { release: sandbox.release });
};

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
export async function statInWorkspace(
  workspaceId: string,
  absPath: string,
  openWorkspace?: OpenWorkspace,
): Promise<WorkspaceStat | null> {
  if (!openWorkspace && appEnv.sandboxBackend === "node") {
    const resolved = await resolveHostPath(workspaceId, absPath);
    if (!resolved) return null;
    const stat = await fs.stat(resolved).catch(() => null);
    return stat ? { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() } : null;
  }
  const reader = await (openWorkspace ?? openDockerWorkspace)(workspaceId);
  try {
    const stat = await reader.fileInfo(absPath);
    return stat.ok
      ? { size: stat.value.size, mtimeMs: stat.value.mtimeMs, isFile: stat.value.kind === "file" }
      : null;
  } finally {
    await reader.release?.();
  }
}

/** Bytes for a confined absolute path, or null when it is absent. */
export async function readInWorkspace(
  workspaceId: string,
  absPath: string,
  openWorkspace?: OpenWorkspace,
): Promise<Uint8Array | null> {
  if (!openWorkspace && appEnv.sandboxBackend === "node") {
    const resolved = await resolveHostPath(workspaceId, absPath);
    return resolved ? fs.readFile(resolved).catch(() => null) : null;
  }
  const reader = await (openWorkspace ?? openDockerWorkspace)(workspaceId);
  try {
    const read = await reader.readBinaryFile(absPath);
    return read.ok ? read.value : null;
  } finally {
    await reader.release?.();
  }
}

async function resolveHostPath(workspaceId: string, absPath: string): Promise<string | null> {
  const root = workspaceRoot(workspaceId);
  const relative = path.relative(root, absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const resolved = await hostResolve(workspaceId, relative);
  return resolved.ok ? resolved.absolutePath : null;
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
