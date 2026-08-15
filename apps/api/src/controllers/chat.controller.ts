import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "../services/agent/agent.service";
import { resolveRun } from "../services/agent/model.service";
import { TranscriptRecorder } from "../services/agent/transcript.service";
import { conversationRepository } from "../repositories/conversation.repository";
import { runRepository } from "../repositories/run.repository";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { fitToWindow } from "../services/context/context-budget.service";
import { describeAttachments } from "../services/media/upload.service";
import { closeStream, createEmitter, startHeartbeat } from "../lib/sse";
import { abortRun, registerRun, unregisterRun } from "../services/agent/run-registry";
import { logger, startTimer } from "../lib/logger";
import { env } from "../config/env";
import type { AgentEvent, ChatRequest } from "../types/agent";
import type { ChatMessage } from "../types/chat";
import type { ConversationStatus } from "../models/schema";
import { currentUserId } from "../middleware/auth";

const newRunId = () => Math.random().toString(36).slice(2, 8);

/**
 * POST /api/chat — run one agent turn, streaming every step back over SSE.
 *
 * The response is always a 200 SSE stream: the client is a live console, so a
 * bad harness/model is reported as an `error` frame it can render inline rather
 * than a status code it would have to special-case mid-stream.
 *
 * The run is recorded as it streams and written once, when it settles — whether
 * that is a clean finish, an error, or the client hanging up mid-flight.
 */
export function stream(c: Context) {
  return streamSSE(c, async (s) => {
    const emit = createEmitter(s);
    // Keeps the connection open across a long, silent tool call. Stopped in the
    // finally below so it can never outlive the run.
    const stopHeartbeat = startHeartbeat(s);

    // The one signal every cancellation path funnels into. Three things can fire
    // it, and none is reliable alone on this Bun:
    //  - the /stop endpoint (registered under conversationId once we have it),
    //  - the request signal, when the runtime does surface a disconnect,
    //  - the stream's own abort, which is what Bun 1.3 actually raises when the
    //    client hangs up (Hono no longer bridges that to the request signal).
    const runAbort = new AbortController();
    const abort = () => runAbort.abort();
    const reqSignal = c.req.raw.signal;
    if (reqSignal.aborted) abort();
    else reqSignal.addEventListener("abort", abort, { once: true });
    s.onAbort(abort);
    let registeredConversationId: string | null = null;

    try {
      const body = (await c.req.json().catch(() => ({}))) as ChatRequest;

      const resolved = resolveRun({
        harnessId: body.harnessId,
        modelId: body.modelId,
        modelConfig: body.modelConfig,
      });

      if (!resolved.ok) {
        logger.warn("run.rejected", { reason: resolved.error });
        emit({ type: "error", message: resolved.error });
        return;
      }

      const { harness, model } = resolved;
      const userId = currentUserId(c);
      // Resolved here, once. Every tool and repository below takes the
      // workspace id rather than the user id, so this is the single place a
      // client-supplied value is checked against ownership.
      const workspace = await workspaceRegistry.resolve(userId, body.workspaceId);
      const history = body.messages ?? [];

      // Attachments become part of the last user message, before the recorder
      // is built from `history` — so the note is what gets stored, and every
      // later turn of the conversation still knows an image was there.
      if (body.imageIds?.length) {
        const note = await describeAttachments(workspace.id, body.imageIds);
        const last = [...history].reverse().find((m) => m.role === "user");
        if (note && last) last.content = `${last.content ?? ""}${note}`;
      }

      const runId = newRunId();
      const timer = startTimer();

      // Continuing an existing thread, or starting one? An unknown or
      // not-owned id starts a new conversation rather than erroring — the client
      // may simply be holding a row that was deleted in another tab.
      const existing = body.conversationId
        ? await conversationRepository.getOwned(body.conversationId, workspace.id)
        : undefined;

      let conversationId: string;
      let recorder: TranscriptRecorder;

      if (existing) {
        conversationId = existing.id;
        // Only this turn's new messages are recorded; everything earlier is
        // already stored, and re-recording it would duplicate the transcript.
        const seqOffset = await conversationRepository.nextSeq(conversationId);
        recorder = new TranscriptRecorder(newTurnOf(history), seqOffset);
        await conversationRepository.setStatus(conversationId, "running");
      } else {
        recorder = new TranscriptRecorder(history);
        conversationId = await conversationRepository.create({
          workspaceId: workspace.id,
          title: recorder.title(),
          modelId: model.id,
          harnessId: harness.id,
        });
      }

      // Now the stop endpoint can find this run. Registered even if the client
      // has already hung up (runAbort would fire on the next check) — the run's
      // finally unregisters it either way.
      registerRun(conversationId, runAbort);
      registeredConversationId = conversationId;

      // Opened before the agent runs, so a run that crashes mid-answer still
      // appears on the timeline as `running` rather than vanishing.
      await runRepository.start({
        id: runId,
        conversationId,
        workspaceId: workspace.id,
        harnessId: harness.id,
        modelId: model.id,
        prompt: newTurnOf(history)[0]?.content ?? "",
      });

      // Let the client bind its local agent to the stored row straight away.
      emit({ type: "conversation", id: conversationId });

      logger.info("run.start", {
        run: runId,
        conversation: conversationId,
        harness: harness.id,
        model: model.id,
      });

      const record = (event: AgentEvent) => {
        recorder.record(event);
        emit(event);
      };

      record({
        type: "trace",
        step: "run.start",
        fields: { harness: harness.id, model: model.id },
      });

      const signal = runAbort.signal;
      let turns = 0;

      // Fit the thread to the model's window before the run, summarising older
      // turns if it no longer fits. Emitted (not recorded) — the meter is live
      // state, not part of the transcript.
      // What the previous turn of THIS conversation actually cost the provider.
      // Null on the first turn, where the estimate is all there is — and where
      // the thread is far too small to need compacting anyway.
      const occupiedTokens =
        (await conversationRepository.lastContextTokens(conversationId)) ?? undefined;

      const budget = await fitToWindow(model, history, signal, occupiedTokens);
      emit(budget.event);
      if (budget.event.compacted) {
        record({
          type: "trace",
          step: "context.compacted",
          fields: budget.event.compacted as unknown as Record<string, unknown>,
        });
      }

      try {
        turns = await runAgent(harness, model, budget.history, record, {
          signal,
          runId,
          template: body.template,
          workspace: body.workspace,
          workspaceId: workspace.id,
          conversationId,
        });
      } catch (e) {
        // The loop reports failures as events; a throw here means it broke outright.
        const message = (e as Error).message;
        logger.error("run.failed", { run: runId, conversation: conversationId, error: message });
        record({ type: "error", message });
      }

      // A run that finished quietly without producing anything is a failure the
      // runtime didn't report. Say so, rather than storing it as a success.
      if (!signal.aborted && !recorder.error() && !recorder.producedOutput()) {
        const message = `${model.label} returned no output — check the gateway URL and that the model name is served.`;
        logger.warn("run.empty", { run: runId, conversation: conversationId, model: model.id });
        record({ type: "error", message });
      }

      const status = runStatus(signal.aborted, recorder.error());
      record({ type: "trace", step: "run.end", fields: { ms: timer.elapsed(), turns, status } });

      await persist(conversationId, recorder, status, runId);
      await closeRun(runId, status, turns, recorder);

      logger.info("run.end", {
        run: runId,
        conversation: conversationId,
        ms: timer.elapsed(),
        turns,
        status,
      });
    } finally {
      if (registeredConversationId) unregisterRun(registeredConversationId, runAbort);
      stopHeartbeat();
      await closeStream(s);
    }
  });
}

/**
 * POST /api/chat/:conversationId/stop — cancel the run in flight.
 *
 * The button cannot stop a run by closing its SSE connection (the disconnect is
 * not bridged to the request signal on this Bun), so it posts here. Scoped and
 * ownership-checked like every other route: a caller can only stop a run in a
 * conversation their own workspace owns. A `stopped: false` means nothing was
 * running under that id — already finished, or never here — which is not an
 * error the client needs to see as one.
 */
export async function stop(c: Context) {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  const conversationId = c.req.param("conversationId") ?? "";
  const owned = await conversationRepository.getOwned(conversationId, workspace.id);
  if (!owned) return c.json({ error: "not found" }, 404);
  const stopped = abortRun(conversationId);
  return c.json({ ok: true, stopped });
}

/**
 * The trailing user message — the one this turn is actually about.
 *
 * The client sends the whole conversation so the model has context, but only
 * the newest message is new to the transcript. Returning it alone keeps the
 * recorder writing exactly one turn's worth of rows.
 */
function newTurnOf(history: ChatMessage[]): ChatMessage[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "user") return [message];
  }
  return [];
}

/**
 * How a run finished. An error the loop reported still counts as an error even
 * though nothing was thrown; a client that hangs up mid-stream is `stopped`,
 * which is a normal outcome here rather than a failure.
 */
function runStatus(aborted: boolean, error: string | null): ConversationStatus {
  if (error) return "error";
  if (aborted) return "stopped";
  return "done";
}

/**
 * Write the recorded run. A persistence failure must not take down a response
 * the client has already received, so it is logged rather than thrown.
 */
async function persist(
  conversationId: string,
  recorder: TranscriptRecorder,
  status: ConversationStatus,
  runId: string,
): Promise<void> {
  try {
    await conversationRepository.appendMessages(conversationId, recorder.toMessageRows());
    await conversationRepository.appendTraces(conversationId, recorder.toTraceRows(), runId);
    await conversationRepository.setStatus(conversationId, status);
  } catch (e) {
    logger.error("conversation.persist_failed", {
      conversation: conversationId,
      error: (e as Error).message,
    });
  }
}

/**
 * Close the run row.
 *
 * Token totals come from the `context.usage` spans the agent recorded, which
 * carry the provider's own counts — the only figures here that are measured
 * rather than estimated. Failing to close a run must not fail the response the
 * client already has, so this is logged, not thrown.
 */
async function closeRun(
  runId: string,
  status: ConversationStatus,
  turns: number,
  recorder: TranscriptRecorder,
): Promise<void> {
  try {
    let tokensIn = 0;
    let tokensOut = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    for (const trace of recorder.toTraceRows()) {
      if (trace.step === "run.tools") {
        toolCalls = Number(trace.fields.toolCalls ?? 0) || 0;
        toolErrors = Number(trace.fields.toolErrors ?? 0) || 0;
        continue;
      }
      if (trace.step !== "context.usage") continue;
      // `used` is the whole prompt for that turn, so the largest is the run's
      // peak occupancy. Summing would double-count the history each turn resends.
      tokensIn = Math.max(tokensIn, Number(trace.fields.used ?? 0) || 0);
      tokensOut += Number(trace.fields.output ?? 0) || 0;
    }
    await runRepository.finish(runId, {
      status,
      turns,
      tokensIn,
      tokensOut,
      toolCalls,
      toolErrors,
      error: recorder.error(),
    });
  } catch (e) {
    logger.error("run.close_failed", { run: runId, error: (e as Error).message });
  }
}
