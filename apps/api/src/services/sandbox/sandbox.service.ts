import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import {
  dockerAvailable,
  ensureImage,
  isRunning,
  removeContainer,
  runDetached,
} from "./docker";

/** Container names must survive Docker's charset rules and stay recognisable. */
const containerNameFor = (workspaceId: string) =>
  `pixelspace-${workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;

/** Serialize lifecycle changes for one workspace without blocking other users. */
const workspaceLocks = new Map<string, Promise<void>>();
const activeLeases = new Map<string, number>();

async function withWorkspaceLock<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(workspaceId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  workspaceLocks.set(workspaceId, tail);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (workspaceLocks.get(workspaceId) === tail) workspaceLocks.delete(workspaceId);
  }
}

async function acquireUnlocked(workspaceId: string): Promise<{ containerId: string; workspacePath: string }> {
  if (!(await dockerAvailable())) {
    throw new Error(
      "Docker isn't reachable. Start Docker Desktop, or set SANDBOX_BACKEND=node to run tools on the API host.",
    );
  }

  const existing = await sandboxRepository.get(workspaceId);
  // Pixelbox rows stored the remote path `/workspace`. Never reuse that as
  // a host bind mount: every Docker workspace has its own canonical root.
  const workspacePath = path.join(env.sandboxRoot, workspaceId);
  fs.mkdirSync(workspacePath, { recursive: true });

  if (
    existing?.containerId &&
    existing.workspacePath === workspacePath &&
    (await isRunning(existing.containerId))
  ) {
    await sandboxRepository.touch(workspaceId);
    return { containerId: existing.containerId, workspacePath };
  }

  if (existing?.containerId) await removeContainer(existing.containerId);
  await removeContainer(containerNameFor(workspaceId));

  await ensureImage(env.sandboxImage);
  const containerId = await runDetached({
    image: env.sandboxImage,
    workspacePath,
    name: containerNameFor(workspaceId),
    skillsPath: env.skillsRoot,
  });

  await sandboxRepository.upsert({
    workspaceId,
    containerId,
    workspacePath,
    image: env.sandboxImage,
  });
  logger.info("sandbox.started", {
    workspace: workspaceId,
    container: containerId.slice(0, 12),
    path: workspacePath,
  });

  return { containerId, workspacePath };
}

/**
 * Owns the container lifecycle behind a workspace's directory.
 *
 * Containers are cattle: started on demand, reused while warm, removed when
 * idle. The directories are not — nothing here ever deletes one.
 *
 * `acquire` / `release` are also the seam where a future hosted backend would
 * sync a workspace down and back up.
 */
export const sandboxService = {
  /** A running container for this workspace, creating or restarting one as needed. */
  async acquire(workspaceId: string): Promise<{ containerId: string; workspacePath: string }> {
    return withWorkspaceLock(workspaceId, () => acquireUnlocked(workspaceId));
  },

  /** Acquire a container and protect it from the idle reaper until released. */
  async acquireLease(workspaceId: string): Promise<{
    containerId: string;
    workspacePath: string;
    release: () => Promise<void>;
  }> {
    return withWorkspaceLock(workspaceId, async () => {
      const sandbox = await acquireUnlocked(workspaceId);
      activeLeases.set(workspaceId, (activeLeases.get(workspaceId) ?? 0) + 1);
      let released = false;
      return {
        ...sandbox,
        release: async () => {
          if (released) return;
          released = true;
          const remaining = (activeLeases.get(workspaceId) ?? 1) - 1;
          if (remaining > 0) activeLeases.set(workspaceId, remaining);
          else activeLeases.delete(workspaceId);
          await sandboxRepository.touch(workspaceId);
        },
      };
    });
  },

  /** Mark the sandbox idle. The container stays warm until reaped. */
  async release(workspaceId: string): Promise<void> {
    await sandboxRepository.touch(workspaceId);
  },

  /**
   * Refresh the in-use timestamp mid-run so the reaper does not remove a
   * container while a run is still using it. `release` does the same at the end;
   * this is the same touch, called on a heartbeat during a long run.
   */
  async keepAlive(workspaceId: string): Promise<void> {
    await sandboxRepository.touch(workspaceId);
  },

  /** Remove containers unused for longer than the window. Returns how many. */
  async reapIdle(olderThanMs: number = env.sandboxIdleMs): Promise<number> {
    const idle = await sandboxRepository.listIdle(olderThanMs);
    const cutoff = Date.now() - olderThanMs;
    let reaped = 0;
    for (const row of idle) {
      await withWorkspaceLock(row.workspaceId, async () => {
        if ((activeLeases.get(row.workspaceId) ?? 0) > 0) return;
        const current = await sandboxRepository.get(row.workspaceId);
        if (!current?.containerId || current.lastUsedAt >= cutoff) return;
        await removeContainer(current.containerId);
        await sandboxRepository.clearContainer(row.workspaceId);
        logger.info("sandbox.reaped", { workspace: row.workspaceId });
        reaped += 1;
      });
    }
    return reaped;
  },

  /** Remove this user's container now. The workspace is left untouched. */
  async destroy(workspaceId: string): Promise<void> {
    await withWorkspaceLock(workspaceId, async () => {
      const row = await sandboxRepository.get(workspaceId);
      if (row?.containerId) await removeContainer(row.containerId);
      await removeContainer(containerNameFor(workspaceId));
      if (row) await sandboxRepository.clearContainer(workspaceId);
    });
  },
};

/**
 * Run the reaper on a timer. Without this, `reapIdle` is never called and
 * containers accumulate for every user who ever ran an agent.
 *
 * The tick follows the idle window so a short window stays responsive, capped
 * at a minute so a long one doesn't mean a long poll. Unref'd, so it never
 * holds the process open.
 */
export function startSandboxReaper(): () => void {
  const intervalMs = Math.max(1_000, Math.min(60_000, env.sandboxIdleMs));
  const timer = setInterval(() => {
    void sandboxService.reapIdle().catch((e) => {
      logger.warn("sandbox.reap_failed", { error: (e as Error).message });
    });
  }, intervalMs);
  timer.unref?.();
  logger.info("sandbox.reaper_started", { everyMs: intervalMs, idleMs: env.sandboxIdleMs });
  return () => clearInterval(timer);
}
