import { and, desc, eq, sql } from "drizzle-orm";
import { db, runs, traces } from "../db/client";
import type { RunRow, RunStatus, TraceRow } from "../models/schema";

/**
 * The only thing that touches `runs`.
 *
 * A run is one prompt turned into an answer: the unit the admin timeline lists
 * and every span hangs from. Conversations already existed, but a conversation
 * is a thread of many runs, and nothing recorded where one ended and the next
 * began.
 *
 * The row is written twice — `start` before the agent runs so an in-flight or
 * crashed run is still visible, and `finish` after. A run that never reaches
 * `finish` stays `running` forever, which is the honest record of a process
 * that died mid-answer.
 */

export type NewRun = {
  id: string;
  conversationId: string;
  workspaceId: string;
  harnessId: string;
  modelId: string;
  prompt: string;
};

export type RunFinish = {
  status: RunStatus;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  toolErrors: number;
  error?: string | null;
};

/** One span on the timeline, already laid out in time. */
export type RunSpan = {
  id: string;
  step: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  fields: Record<string, unknown>;
};

/** One tool this workspace has actually called, and how often. */
export type ToolUsage = { name: string; calls: number };

/** How long the prompt preview stored on the row may be. */
const PROMPT_PREVIEW = 300;

export const runRepository = {
  /** Record a run as started. Returns nothing; the caller already has the id. */
  async start(run: NewRun): Promise<void> {
    await db.insert(runs).values({
      id: run.id,
      conversationId: run.conversationId,
      workspaceId: run.workspaceId,
      harnessId: run.harnessId,
      modelId: run.modelId,
      prompt: run.prompt.slice(0, PROMPT_PREVIEW),
      startedAt: Date.now(),
      status: "running",
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      toolCalls: 0,
      toolErrors: 0,
    });
  },

  async finish(runId: string, outcome: RunFinish): Promise<void> {
    await db
      .update(runs)
      .set({
        endedAt: Date.now(),
        status: outcome.status,
        turns: outcome.turns,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        toolCalls: outcome.toolCalls,
        toolErrors: outcome.toolErrors,
        error: outcome.error ?? null,
      })
      .where(eq(runs.id, runId));
  },

  /** A workspace's runs, newest first. */
  async list(workspaceId: string, limit = 50): Promise<RunRow[]> {
    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.workspaceId, workspaceId))
      .orderBy(desc(runs.startedAt))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows as RunRow[];
  },

  async get(workspaceId: string, runId: string): Promise<RunRow | null> {
    const rows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)));
    return (rows[0] as RunRow) ?? null;
  },

  /**
   * Which tools this workspace has called, most-used first.
   *
   * Read by the MCP layer to decide which tools stay loaded in the model's
   * context: a workspace's own history is a better allowlist than a curated
   * one, and it needs no UI to maintain. See `mcp/tool-search.ts`.
   *
   * The name lives inside the span's JSON rather than in a column, so this
   * reaches into `fields` with `json_extract`. That is the one place it is
   * done; a column would be the right answer if a second reader ever wanted
   * the same grouping.
   *
   * Joined through `runs` because `traces` has no workspace of its own — a
   * span belongs to a run, and the run knows the workspace. Spans written
   * before runs existed have a null `run_id` and drop out of the join, which
   * is correct: they cannot be attributed to a workspace at all.
   */
  async toolUsage(
    workspaceId: string,
    limit = 50,
    // Injectable only so the join and the json_extract can be tested against a
    // real in-memory schema. Everything else here uses the singleton; a query
    // that silently returns nothing forever is the failure worth covering.
    dbImpl: typeof db = db,
  ): Promise<ToolUsage[]> {
    const name = sql<string>`json_extract(${traces.fields}, '$.name')`;
    const rows = await dbImpl
      .select({ name, calls: sql<number>`count(*)` })
      .from(traces)
      .innerJoin(runs, eq(traces.runId, runs.id))
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          eq(traces.step, "tool"),
          // `json_extract` raises rather than returning null when the column is
          // not valid JSON, so one malformed span would fail the whole query
          // and cost the workspace its entire core tool set.
          sql`json_valid(${traces.fields})`,
        ),
      )
      .groupBy(name)
      .orderBy(sql`count(*) desc`)
      .limit(Math.max(1, Math.min(500, limit)));

    // A span whose fields failed to parse yields a null name. Dropped rather
    // than surfaced as a tool called "null".
    return rows
      .filter((r): r is ToolUsage => typeof r.name === "string" && r.name.length > 0)
      .map((r) => ({ name: r.name, calls: Number(r.calls) }));
  },

  /**
   * A run's spans, oldest first, with start and end resolved.
   *
   * `ts` records when a span *ended*, so the start is derived. Doing it here
   * rather than in the client keeps the timeline maths in one place and means
   * the API returns something already drawable.
   */
  async spans(runId: string): Promise<RunSpan[]> {
    const rows = (await db
      .select()
      .from(traces)
      .where(eq(traces.runId, runId))
      .orderBy(sql`ts asc`)) as TraceRow[];

    return rows.map((row) => {
      const duration = row.durationMs ?? 0;
      let fields: Record<string, unknown> = {};
      try {
        fields = row.fields ? (JSON.parse(row.fields) as Record<string, unknown>) : {};
      } catch {
        // A malformed row must not remove every other span from the timeline.
        fields = { raw: row.fields };
      }
      return {
        id: row.id,
        step: row.step,
        startedAt: row.ts - duration,
        endedAt: row.ts,
        durationMs: duration,
        fields,
      };
    });
  },
};
