import fs from "node:fs";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import { PixelboxError, PixelboxSandboxClient, type SandboxApi } from "./pixelbox-client";

/** Every remote sandbox mounts its workspace here; there is no host path. */
export const WORKSPACE_PATH = "/workspace";

/**
 * In-sandbox path a skill's files are addressed under. The docker backend
 * bind-mounted the host skills directory here read-only; the Pixelbox backend
 * has no such mount yet, so `call_skill` depends on the approved coding image
 * carrying the skills at this path (provisioning them into a remote sandbox is
 * follow-up work). The constant stays the single source of the path either way.
 */
export const SKILLS_MOUNT = "/skills";

/**
 * The Sandbox API, built lazily from the environment so importing this module
 * never requires credentials — tests inject a fake instead. Built once because a
 * client only holds a base URL and a token.
 */
let client: SandboxApi | undefined;
function api(): SandboxApi {
  return (client ??= PixelboxSandboxClient.fromEnv((path) => fs.readFileSync(path, "utf8")));
}

/** Test seam: drive the lifecycle against an in-memory {@link SandboxApi}. */
export function setSandboxApiForTests(fake: SandboxApi): void {
  client = fake;
}

/** The API the execution env talks to for this run's shell and file operations. */
export function sandboxApi(): SandboxApi {
  return api();
}

/** Is this sandbox still alive on the service? A vanished pod answers 404. */
async function isAlive(sandboxId: string): Promise<boolean> {
  try {
    const info = await api().get(sandboxId);
    return info.state === "ready" || info.state === "running" || info.state === "created";
  } catch (e) {
    if (e instanceof PixelboxError && e.code === "NOT_FOUND") return false;
    // A transport blip should not silently orphan a good sandbox; surface it as
    // "not reusable" so acquire creates a fresh one rather than throwing.
    logger.warn("sandbox.liveness_failed", { sandbox: sandboxId, error: (e as Error).message });
    return false;
  }
}

/**
 * Owns the remote sandbox lifecycle behind a workspace.
 *
 * One sandbox per workspace: created on first use, reused while it stays alive,
 * deleted when idle. The `containerId` column carries the opaque sandbox id now
 * that the backend is remote — the row's shape is unchanged, only what fills it.
 *
 * The NFS workspace outlives any single sandbox, so a null id is the normal cold
 * state, not a lost workspace.
 */
export const sandboxService = {
  /** A live sandbox for this workspace, creating one when there is none. */
  async acquire(workspaceId: string): Promise<{ sandboxId: string; workspacePath: string }> {
    const existing = await sandboxRepository.get(workspaceId);
    if (existing?.containerId && (await isAlive(existing.containerId))) {
      await sandboxRepository.touch(workspaceId);
      return { sandboxId: existing.containerId, workspacePath: WORKSPACE_PATH };
    }

    const created = await api().create({
      // Generous enough that a run and the model's thinking between tool calls
      // outlast it only rarely; our own reaper is the real idle bound.
      timeoutSeconds: Math.max(3_600, Math.ceil(env.sandboxIdleMs / 1000) * 2),
      tags: { workspace: workspaceId },
    });

    await sandboxRepository.upsert({
      workspaceId,
      containerId: created.sandboxId,
      workspacePath: WORKSPACE_PATH,
      image: "pixelbox",
    });
    logger.info("sandbox.started", { workspace: workspaceId, sandbox: created.sandboxId });
    return { sandboxId: created.sandboxId, workspacePath: WORKSPACE_PATH };
  },

  /** Mark the sandbox idle. It stays alive until reaped. */
  async release(workspaceId: string): Promise<void> {
    await sandboxRepository.touch(workspaceId);
  },

  /**
   * Refresh the in-use timestamp mid-run so the reaper does not delete a sandbox
   * a run is still using. Called on a heartbeat during a long run; `release`
   * does the same touch at the end.
   */
  async keepAlive(workspaceId: string): Promise<void> {
    await sandboxRepository.touch(workspaceId);
  },

  /** Delete sandboxes unused for longer than the window. Returns how many. */
  async reapIdle(olderThanMs: number = env.sandboxIdleMs): Promise<number> {
    const idle = await sandboxRepository.listIdle(olderThanMs);
    for (const row of idle) {
      if (row.containerId) {
        try {
          await api().delete(row.containerId);
        } catch (e) {
          logger.warn("sandbox.reap_delete_failed", { sandbox: row.containerId, error: (e as Error).message });
        }
      }
      await sandboxRepository.clearContainer(row.workspaceId);
      logger.info("sandbox.reaped", { workspace: row.workspaceId });
    }
    return idle.length;
  },

  /** Delete this workspace's sandbox now. The NFS workspace is left untouched. */
  async destroy(workspaceId: string): Promise<void> {
    const row = await sandboxRepository.get(workspaceId);
    if (row?.containerId) {
      try {
        await api().delete(row.containerId);
      } catch (e) {
        logger.warn("sandbox.destroy_failed", { sandbox: row.containerId, error: (e as Error).message });
      }
      await sandboxRepository.clearContainer(workspaceId);
    }
  },
};

/**
 * Run the reaper on a timer. Without this, `reapIdle` is never called and
 * sandboxes accumulate for every workspace that ever ran an agent.
 *
 * The tick follows the idle window so a short window stays responsive, capped at
 * a minute so a long one doesn't mean a long poll. Unref'd, so it never holds
 * the process open.
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
