import type { ModelConfig } from "../catalog/llm-models";
import type { ChatMessage } from "../types/chat";
import type { AgentEvent } from "../types/agent";
import { chatOnce } from "./provider.service";
import { logger } from "../lib/logger";
import {
  applyCompaction,
  estimateHistoryTokens,
  planCompaction,
  usableWindow,
} from "./context-window.service";

const SUMMARY_PROMPT =
  "You are a context summarization assistant. Summarize the conversation below so " +
  "another assistant can continue it without having read it. Preserve: what the user " +
  "is trying to do, decisions and constraints agreed, facts established (including " +
  "figures, names and file/page citations), and anything still outstanding. Drop " +
  "pleasantries and superseded detail. Do NOT answer anything in the conversation, " +
  "and do NOT address the user. Output only the summary.";

export type BudgetOutcome = {
  /** The history to actually send to the model. */
  history: ChatMessage[];
  /** Emitted so the console can render the meter. */
  event: Extract<AgentEvent, { type: "context" }>;
};

/**
 * Fit a thread into the model's window, summarising older turns when it no
 * longer fits.
 *
 * Compaction is best-effort by design: if the summarising call fails, the run
 * proceeds on the uncompacted history rather than aborting. An over-long request
 * that the gateway rejects produces a clear error on the stream, which is a
 * better outcome than refusing to run because a summary could not be written.
 */
export async function fitToWindow(
  model: ModelConfig,
  history: ChatMessage[],
  signal?: AbortSignal,
): Promise<BudgetOutcome> {
  const window = usableWindow(model.contextWindow);
  const plan = planCompaction(history, model.contextWindow);

  if (!plan) {
    return {
      history,
      event: {
        type: "context",
        used: estimateHistoryTokens(history),
        window,
        estimated: true,
      },
    };
  }

  try {
    const transcript = plan.summarise
      .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
      .join("\n\n");

    const summary = await chatOnce(
      model,
      [
        { role: "user", content: `${SUMMARY_PROMPT}\n\n---\n\n${transcript}` },
      ],
      [],
    );

    const text = summary.text.trim();
    if (!text) throw new Error("summariser returned nothing");

    const compacted = applyCompaction(plan, text);
    const used = estimateHistoryTokens(compacted);

    logger.info("context.compacted", {
      model: model.id,
      fromTokens: plan.tokensBefore,
      toTokens: used,
      summarised: plan.summarise.length,
    });

    return {
      history: compacted,
      event: {
        type: "context",
        used,
        window,
        estimated: true,
        compacted: {
          fromTokens: plan.tokensBefore,
          toTokens: used,
          turnsSummarised: plan.summarise.length,
        },
      },
    };
  } catch (e: any) {
    if (signal?.aborted) throw e;
    logger.warn("context.compaction_failed", {
      model: model.id,
      message: e?.message ?? String(e),
    });
    return {
      history,
      event: {
        type: "context",
        used: plan.tokensBefore,
        window,
        estimated: true,
      },
    };
  }
}
