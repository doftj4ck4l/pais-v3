import type { Context } from "hono";
import { adminAnalyticsRepository } from "../repositories/admin-analytics.repository";
import { runRepository } from "../repositories/run.repository";
import type { RunStatus } from "../models/schema";

const RUN_STATUSES = new Set<RunStatus>(["running", "done", "error", "stopped"]);

function integerQuery(c: Context, name: string, fallback: number): number {
  const value = Number(c.req.query(name) ?? fallback);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** GET /api/admin/analytics — all-tenant totals and the requested activity window. */
export async function analytics(c: Context) {
  return c.json(await adminAnalyticsRepository.overview(integerQuery(c, "days", 30)));
}

/** GET /api/admin/users — every persisted app user, including independent users. */
export async function listUsers(c: Context) {
  return c.json(
    await adminAnalyticsRepository.listUsers({
      limit: integerQuery(c, "limit", 50),
      offset: integerQuery(c, "offset", 0),
      query: c.req.query("q") ?? "",
    }),
  );
}

/** GET /api/admin/runs — recent runs across the entire platform, newest first. */
export async function listRuns(c: Context) {
  const requestedStatus = c.req.query("status") as RunStatus | undefined;
  const result = await runRepository.listPlatform({
    limit: integerQuery(c, "limit", 50),
    offset: integerQuery(c, "offset", 0),
    query: c.req.query("q") ?? "",
    userId: c.req.query("userId"),
    organizationId: c.req.query("organizationId"),
    status: requestedStatus && RUN_STATUSES.has(requestedStatus) ? requestedStatus : undefined,
  });

  return c.json({
    total: result.total,
    runs: result.runs.map((run) => ({
      ...run,
      durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
    })),
  });
}

/** GET /api/admin/runs/:id — one platform run and its recorded spans. */
export async function getRun(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing run id" }, 400);

  const run = await runRepository.getPlatform(id);
  if (!run) return c.json({ error: "Run not found" }, 404);

  const spans = await runRepository.spans(id);
  const lastSpanEnd = spans.reduce((max, span) => Math.max(max, span.endedAt), run.startedAt);
  const endedAt = run.endedAt ?? lastSpanEnd;

  return c.json({
    run: { ...run, endedAt, durationMs: Math.max(0, endedAt - run.startedAt) },
    spans: spans.map((span) => ({
      ...span,
      offsetMs: Math.max(0, span.startedAt - run.startedAt),
    })),
  });
}
