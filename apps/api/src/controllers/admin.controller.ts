import type { Context } from "hono";
import { env } from "../config/env";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { runRepository } from "../repositories/run.repository";
import { currentUserId } from "../middleware/auth";

/**
 * Read-only views over recorded runs, for the admin timeline.
 *
 * Everything here is scoped to a workspace the caller owns, exactly like the
 * other controllers — "admin" names the audience, not an elevated permission.
 */

const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/** GET /api/admin/runs — recent runs in this workspace, newest first. */
export async function listRuns(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const limit = Number(c.req.query("limit") ?? 50);
  const runs = await runRepository.list(workspaceId, Number.isFinite(limit) ? limit : 50);

  return c.json({
    runs: runs.map((run) => ({
      ...run,
      // Computed here so the list can be sorted and filtered by duration
      // without every client re-deriving it. A run still in flight has none.
      durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
    })),
  });
}

/**
 * GET /api/admin/runs/:id — one run and its spans, ready to draw.
 *
 * Spans arrive with absolute start and end times. The timeline's zero point is
 * the run's own start rather than the earliest span, so setup work that begins
 * before the first span still lands in the right place.
 */
export async function getRun(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing run id" }, 400);

  const run = await runRepository.get(workspaceId, id);
  if (!run) return c.json({ error: "Run not found" }, 404);

  const spans = await runRepository.spans(id);

  // A run that crashed before `finish` has no end time; the last span is the
  // best available answer, and the start is the floor so a clock skew cannot
  // produce a negative duration.
  const lastSpanEnd = spans.reduce((max, s) => Math.max(max, s.endedAt), run.startedAt);
  const endedAt = run.endedAt ?? lastSpanEnd;

  return c.json({
    run: { ...run, endedAt, durationMs: Math.max(0, endedAt - run.startedAt) },
    spans: spans.map((span) => ({
      ...span,
      /** Milliseconds from the run's start — what the bar's offset is drawn from. */
      offsetMs: Math.max(0, span.startedAt - run.startedAt),
    })),
  });
}
