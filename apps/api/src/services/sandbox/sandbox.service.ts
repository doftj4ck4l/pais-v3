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
const containerNameFor = (userId: string) =>
  `mixmatch-${userId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;

/**
 * Owns the container lifecycle behind a user's workspace.
 *
 * Containers are cattle: started on demand, reused while warm, removed when
 * idle. Workspaces are not — nothing here ever deletes one.
 *
 * `acquire` / `release` are also the seam where a future hosted backend would
 * sync a workspace down and back up.
 */
export const sandboxService = {
  /** A running container for this user, creating or restarting one as needed. */
  async acquire(userId: string): Promise<{ containerId: string; workspacePath: string }> {
    if (!(await dockerAvailable())) {
      throw new Error(
        "Docker isn't reachable. Start Docker Desktop, or set SANDBOX_BACKEND=node to run tools on the API host.",
      );
    }

    const existing = await sandboxRepository.get(userId);
    const workspacePath = existing?.workspacePath ?? path.join(env.sandboxRoot, userId);
    fs.mkdirSync(workspacePath, { recursive: true });

    if (existing?.containerId && (await isRunning(existing.containerId))) {
      await sandboxRepository.touch(userId);
      return { containerId: existing.containerId, workspacePath };
    }

    // Either a first run or a stale row. Clear both the recorded container and
    // any orphan left behind by a previous process before starting fresh.
    if (existing?.containerId) await removeContainer(existing.containerId);
    await removeContainer(containerNameFor(userId));

    await ensureImage(env.sandboxImage);
    const containerId = await runDetached({
      image: env.sandboxImage,
      workspacePath,
      name: containerNameFor(userId),
    });

    await sandboxRepository.upsert({
      userId,
      containerId,
      workspacePath,
      image: env.sandboxImage,
    });
    logger.info("sandbox.started", {
      user: userId,
      container: containerId.slice(0, 12),
      workspace: workspacePath,
    });

    return { containerId, workspacePath };
  },

  /** Mark the sandbox idle. The container stays warm until reaped. */
  async release(userId: string): Promise<void> {
    await sandboxRepository.touch(userId);
  },

  /** Remove containers unused for longer than the window. Returns how many. */
  async reapIdle(olderThanMs: number = env.sandboxIdleMs): Promise<number> {
    const idle = await sandboxRepository.listIdle(olderThanMs);
    for (const row of idle) {
      if (row.containerId) await removeContainer(row.containerId);
      await sandboxRepository.clearContainer(row.userId);
      logger.info("sandbox.reaped", { user: row.userId });
    }
    return idle.length;
  },

  /** Remove this user's container now. The workspace is left untouched. */
  async destroy(userId: string): Promise<void> {
    const row = await sandboxRepository.get(userId);
    if (row?.containerId) await removeContainer(row.containerId);
    await removeContainer(containerNameFor(userId));
    if (row) await sandboxRepository.clearContainer(userId);
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
