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
