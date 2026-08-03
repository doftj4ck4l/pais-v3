import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

/**
 * Read access to a user's sandbox workspace.
 *
 * The only module that turns a client-supplied path into a real one. That is
 * the whole point: this directory is written by an agent, so every path is
 * hostile until proven otherwise, and keeping the resolution in one place means
 * there is one thing to get right and one thing to test.
 */

export type WorkspaceFile = {
  /** Path relative to the workspace root, using forward slashes. */
  path: string;
  bytes: number;
  modifiedAt: number;
};

export type Resolved =
  | { ok: true; absolutePath: string }
  /** Missing and rejected are one outcome on purpose — see `resolve`. */
  | { ok: false };

export function workspaceRoot(userId: string): string {
  return path.join(env.sandboxRoot, userId);
}

/**
 * Resolve a request path inside the user's workspace, or reject it.
 *
 * Three checks, because each defeats a different attack:
 *
 * 1. Reject absolute paths and `..` segments before touching disk, so an
 *    obviously hostile path never reaches the filesystem at all.
 * 2. Resolve and require the workspace prefix, which catches traversal that
 *    survives normalisation.
 * 3. Resolve symlinks and re-check the prefix. The agent can create symlinks
 *    inside its own workspace, so a link pointing at /etc/passwd would pass
 *    every purely textual check.
 *
 * Rejected and missing return the same value, so the endpoint cannot be used to
 * probe the host's filesystem layout.
 */
export async function resolve(userId: string, requestPath: string): Promise<Resolved> {
  const root = workspaceRoot(userId);

  if (!requestPath || path.isAbsolute(requestPath)) return { ok: false };
  const segments = requestPath.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some((s) => s === "..")) return { ok: false };

  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) return { ok: false };

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return { ok: false };
  }
  if (!isInside(await realRoot(root), real)) return { ok: false };

  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) return { ok: false };

  return { ok: true, absolutePath: real };
}

/** True when `target` is the directory itself or sits beneath it. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The workspace root with symlinks resolved. The root itself can sit behind a
 * link (/tmp on macOS, for one), and comparing a resolved file against an
 * unresolved root would then reject every legitimate path.
 */
async function realRoot(root: string): Promise<string> {
  return fs.realpath(root).catch(() => root);
}

/** Every file in the workspace, newest first. Directories are walked, not listed. */
export async function list(userId: string, limit = 200): Promise<WorkspaceFile[]> {
  const root = workspaceRoot(userId);
  const out: WorkspaceFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || out.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      // Do not follow links while walking: a link out of the workspace would
      // otherwise be listed as if it belonged to the user.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) continue;
        out.push({
          path: path.relative(root, full).split(path.sep).join("/"),
          bytes: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      }
    }
  }

  await walk(root, 0);
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
