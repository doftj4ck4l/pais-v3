import fs from "node:fs";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import { PixelboxError, PixelboxSandboxClient, type SandboxApi, type SandboxInfo } from "./pixelbox-client";
import { PYTHON_BASELINE_SPECS, PYTHON_RUNTIME_ENV } from "./python-baseline";

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
 * Common task libraries installed into each cold sandbox until Pixelbox can
 * provide a prewarmed image/session hook. Keep direct requirements pinned so a
 * top-level PyPI release cannot silently change this production path.
 */
const PREWARM_TIMEOUT_SECONDS = 15 * 60;
const PREWARM_DEADLINE_ALLOWANCE_MS = 30_000;
const DEFAULT_PREWARM_DEADLINE_MS = PREWARM_TIMEOUT_SECONDS * 1_000 + PREWARM_DEADLINE_ALLOWANCE_MS;
const START_TIMEOUT_MS = 60_000;
const START_POLL_MS = 250;
const PREWARM_MANIFEST_PATH = `${WORKSPACE_PATH}/.pixelspace/python-prewarm-manifest`;
const PREWARM_MANIFEST = ["pixelspace-python-prewarm/v1", ...PYTHON_BASELINE_SPECS, ""].join("\n");

/** Create is asynchronous on Pixelbox; execution returns 503 until the pod is ready. */
async function waitUntilReady(sandboxId: string, initial?: SandboxInfo): Promise<void> {
  const deadline = performance.now() + START_TIMEOUT_MS;
  let info = initial;

  while (true) {
    if (!info) {
      try {
        info = await api().get(sandboxId);
      } catch (e) {
        if (!(e instanceof PixelboxError) || e.code !== "SANDBOX_UNAVAILABLE") throw e;
      }
    }

    if (info?.state === "ready" || info?.state === "running") return;
    if (info?.state === "finished" || info?.state === "error") {
      throw new Error(`Sandbox ${sandboxId} entered terminal state ${info.state} before it was ready`);
    }
    if (performance.now() >= deadline) {
      throw new Error(`Sandbox ${sandboxId} was not ready after ${START_TIMEOUT_MS / 1000} seconds`);
    }

    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    info = undefined;
  }
}

/** A cold sandbox is not ready for an agent until its baseline packages are. */
async function prewarm(sandboxId: string): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new DOMException("Sandbox dependency prewarm transport timed out", "TimeoutError"));
  }, prewarmDeadlineMs);
  deadline.unref?.();

  try {
    try {
      const existing = await api().readBytes(sandboxId, PREWARM_MANIFEST_PATH, controller.signal);
      if (new TextDecoder().decode(existing) === PREWARM_MANIFEST) return;
    } catch (e) {
      if (!(e instanceof PixelboxError) || e.code !== "NOT_FOUND") throw e;
    }

    const startedAt = performance.now();
    const result = await api().execute(
      sandboxId,
      {
        command: [
          "python3 -m pip install",
          "--no-cache-dir",
          "--disable-pip-version-check",
          "--no-input",
          "--break-system-packages",
          "--user",
          ...PYTHON_BASELINE_SPECS,
        ].join(" "),
        cwd: WORKSPACE_PATH,
        timeoutSeconds: PREWARM_TIMEOUT_SECONDS,
        maxOutputBytes: 64 * 1024,
        env: { ...PYTHON_RUNTIME_ENV },
      },
      controller.signal,
    );

    if (result.timedOut) {
      throw new Error(`Sandbox dependency prewarm timed out after ${PREWARM_TIMEOUT_SECONDS} seconds`);
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `pip exited with code ${result.exitCode}`;
      throw new Error(`Sandbox dependency prewarm failed: ${detail}`);
    }

    await api().createDir(sandboxId, `${WORKSPACE_PATH}/.pixelspace`, true, controller.signal);
    await api().writeBytes(
      sandboxId,
      PREWARM_MANIFEST_PATH,
      new TextEncoder().encode(PREWARM_MANIFEST),
      controller.signal,
    );

    logger.info("sandbox.prewarmed", {
      sandbox: sandboxId,
      packages: PYTHON_BASELINE_SPECS.length,
      ms: Math.round(performance.now() - startedAt),
    });
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * The Sandbox API, built lazily from the environment so importing this module
 * never requires credentials — tests inject a fake instead. Built once because a
 * client only holds a base URL and a token.
 */
let client: SandboxApi | undefined;
let prewarmDeadlineMs = DEFAULT_PREWARM_DEADLINE_MS;
function api(): SandboxApi {
  return (client ??= PixelboxSandboxClient.fromEnv((path) => fs.readFileSync(path, "utf8")));
}

/** Test seam: drive the lifecycle against an in-memory {@link SandboxApi}. */
export function setSandboxApiForTests(fake: SandboxApi, options?: { prewarmDeadlineMs?: number }): void {
  client = fake;
  prewarmDeadlineMs = options?.prewarmDeadlineMs ?? DEFAULT_PREWARM_DEADLINE_MS;
}

/** The API the execution env talks to for this run's shell and file operations. */
export function sandboxApi(): SandboxApi {
  return api();
}

/** Is this sandbox still alive on the service? A vanished pod answers 404. */
async function liveInfo(sandboxId: string): Promise<SandboxInfo | undefined> {
  try {
    const info = await api().get(sandboxId);
    return info.state === "ready" || info.state === "running" || info.state === "created" ? info : undefined;
  } catch (e) {
    if (e instanceof PixelboxError && e.code === "NOT_FOUND") return undefined;
    // A transport blip should not silently orphan a good sandbox; surface it as
    // "not reusable" so acquire creates a fresh one rather than throwing.
    logger.warn("sandbox.liveness_failed", { sandbox: sandboxId, error: (e as Error).message });
    return undefined;
  }
}

type AcquiredSandbox = { sandboxId: string; workspacePath: string };
const pendingAcquisitions = new Map<string, Promise<AcquiredSandbox>>();

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Sandbox acquisition aborted", "AbortError");
}

/** Detach one caller from a shared bootstrap without cancelling that bootstrap. */
function waitForAcquisition(acquisition: Promise<AcquiredSandbox>, signal?: AbortSignal): Promise<AcquiredSandbox> {
  if (!signal) return acquisition;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    acquisition.then(
      (sandbox) => {
        signal.removeEventListener("abort", onAbort);
        resolve(sandbox);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function acquireSandbox(workspaceId: string): Promise<AcquiredSandbox> {
  const existing = await sandboxRepository.get(workspaceId);
  const existingInfo = existing?.containerId ? await liveInfo(existing.containerId) : undefined;
  if (existing?.containerId && existingInfo) {
    // Reuse can still pay the full bootstrap cost when the manifest changed.
    // Refresh first so an idle scan started during that work does not select it.
    await sandboxRepository.touch(workspaceId);
    await waitUntilReady(existing.containerId, existingInfo);
    await prewarm(existing.containerId);
    return { sandboxId: existing.containerId, workspacePath: WORKSPACE_PATH };
  }

  const created = await api().create({
    // Generous enough that a run and the model's thinking between tool calls
    // outlast it only rarely; our own reaper is the real idle bound.
    timeoutSeconds: Math.max(3_600, Math.ceil(env.sandboxIdleMs / 1000) * 2),
    tags: { workspace: workspaceId },
  });

  try {
    await waitUntilReady(created.sandboxId, created);
    await prewarm(created.sandboxId);
  } catch (e) {
    // Never persist or return a half-provisioned sandbox. A later acquire can
    // start cleanly, while the original install error remains the one callers
    // see even if best-effort cleanup also fails.
    try {
      await api().delete(created.sandboxId);
    } catch (cleanupError) {
      logger.warn("sandbox.prewarm_cleanup_failed", {
        sandbox: created.sandboxId,
        error: (cleanupError as Error).message,
      });
    }
    throw e;
  }

  await sandboxRepository.upsert({
    workspaceId,
    containerId: created.sandboxId,
    workspacePath: WORKSPACE_PATH,
    image: "pixelbox",
  });
  logger.info("sandbox.started", { workspace: workspaceId, sandbox: created.sandboxId });
  return { sandboxId: created.sandboxId, workspacePath: WORKSPACE_PATH };
}

/**
 * Owns the remote sandbox lifecycle behind a workspace.
 *
 * One sandbox per workspace: created on first use, reused while it stays alive,
 * deleted when idle. The `containerId` column carries the opaque sandbox id now
 * that the backend is remote — the row's shape is unchanged, only what fills it.
 *
 * The remote workspace volume lives with its sandbox, so a null id is the normal
 * cold state and the next acquire provisions both again.
 */
export const sandboxService = {
  /** A live sandbox for this workspace, creating one when there is none. */
  async acquire(workspaceId: string, signal?: AbortSignal): Promise<{ sandboxId: string; workspacePath: string }> {
    if (signal?.aborted) throw abortReason(signal);

    let acquisition = pendingAcquisitions.get(workspaceId);
    if (!acquisition) {
      acquisition = acquireSandbox(workspaceId);
      pendingAcquisitions.set(workspaceId, acquisition);

      // Map ownership belongs to the bootstrap itself. An aborted waiter must
      // not clear the entry while another run is still waiting on the same work.
      void acquisition.then(
        () => {
          if (pendingAcquisitions.get(workspaceId) === acquisition) pendingAcquisitions.delete(workspaceId);
        },
        () => {
          if (pendingAcquisitions.get(workspaceId) === acquisition) pendingAcquisitions.delete(workspaceId);
        },
      );
    }

    return waitForAcquisition(acquisition, signal);
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
    let reaped = 0;
    for (const row of idle) {
      // A reuse bootstrap may be reinstalling packages into an old row. Its
      // timestamp is refreshed before that work, and this closes the scan race.
      if (pendingAcquisitions.has(row.workspaceId)) continue;
      if (row.containerId) {
        try {
          await api().delete(row.containerId);
        } catch (e) {
          logger.warn("sandbox.reap_delete_failed", { sandbox: row.containerId, error: (e as Error).message });
        }
      }
      await sandboxRepository.clearContainer(row.workspaceId);
      logger.info("sandbox.reaped", { workspace: row.workspaceId });
      reaped += 1;
    }
    return reaped;
  },

  /** Delete this workspace's sandbox and its remote volume now. */
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
