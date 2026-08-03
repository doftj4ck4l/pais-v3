import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "../services/agent.service";
import { resolveRun } from "../services/model.service";
import { TranscriptRecorder } from "../services/transcript.service";
import { conversationRepository } from "../repositories/conversation.repository";
import { fitToWindow } from "../services/context-budget.service";
import { closeStream, createEmitter } from "../lib/sse";
import { logger, startTimer } from "../lib/logger";
import { env } from "../config/env";
import type { AgentEvent, ChatRequest } from "../types/agent";
import type { ChatMessage } from "../types/chat";
import type { ConversationStatus } from "../models/schema";

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
    const body = (await c.req.json().catch(() => ({}))) as ChatRequest;

    const resolved = resolveRun({
      harnessId: body.harnessId,
      modelId: body.modelId,
      modelConfig: body.modelConfig,
    });

    if (!resolved.ok) {
      logger.warn("run.rejected", { reason: resolved.error });
      emit({ type: "error", message: resolved.error });
      await closeStream(s);
      return;
    }

    const { harness, model } = resolved;
    const userId = body.userId ?? env.defaultUserId;
    const history = body.messages ?? [];
    const runId = newRunId();
    const timer = startTimer();

    // Continuing an existing thread, or starting one? An unknown or
    // not-owned id starts a new conversation rather than erroring — the client
    // may simply be holding a row that was deleted in another tab.
    const existing = body.conversationId
      ? await conversationRepository.getOwned(body.conversationId, userId)
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
        userId,
        title: recorder.title(),
        modelId: model.id,
        harnessId: harness.id,
      });
    }

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

    const signal = c.req.raw.signal;
    let turns = 0;

    // Fit the thread to the model's window before the run, summarising older
    // turns if it no longer fits. Emitted (not recorded) — the meter is live
    // state, not part of the transcript.
    const budget = await fitToWindow(model, history, signal);
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
        userId,
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

    await persist(conversationId, recorder, status);

    logger.info("run.end", {
      run: runId,
      conversation: conversationId,
      ms: timer.elapsed(),
      turns,
      status,
    });
    await closeStream(s);
  });
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
): Promise<void> {
  try {
    await conversationRepository.appendMessages(conversationId, recorder.toMessageRows());
    await conversationRepository.appendTraces(conversationId, recorder.toTraceRows());
    await conversationRepository.setStatus(conversationId, status);
  } catch (e) {
    logger.error("conversation.persist_failed", {
      conversation: conversationId,
      error: (e as Error).message,
    });
  }
}
