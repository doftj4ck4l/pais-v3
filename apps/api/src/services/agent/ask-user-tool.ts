import type { AgentEvent } from "../../types/agent";
import { cancelQuestion, registerQuestion } from "./elicitation-registry";

/**
 * The `ask_user` tool: the agent's way to stop and ask a human, mid-run.
 *
 * This is elicitation, not permission — the agent has hit ambiguity or missing
 * information (which of two calendars? which file did you mean?) and needs an
 * answer before it can continue. It emits an `ask_user` event down the live SSE
 * stream and then *awaits* the user's reply: the run is genuinely paused here,
 * in-process, holding the connection open (the heartbeat keeps it alive) until
 * an answer arrives on POST /api/chat/:conversationId/answer.
 *
 * Waiting is bounded by the run's own abort signal, so a stopped run or a closed
 * tab (which aborts the run) releases the wait instead of hanging forever.
 */

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: { output: string };
};

function text(out: string): ToolResult {
  return { content: [{ type: "text" as const, text: out }], details: { output: out } };
}

export type AskUserTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: any, signal?: AbortSignal) => Promise<ToolResult>;
};

let counter = 0;
/** Unique per question. Not crypto — it only has to be distinct within a run. */
function newQuestionId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `q_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function createAskUserTool(
  conversationId: string,
  emit: (event: AgentEvent) => void,
): AskUserTool {
  return {
    name: "ask_user",
    label: "ask_user",
    description:
      "Ask the user a question and wait for their answer. Use this when the request is ambiguous " +
      "or you are missing information you cannot infer — for example when more than one thing " +
      "matches (two calendars, several files with the same name) and the user did not say which. " +
      "Prefer asking over guessing when a wrong guess would take a real action. Provide `options` " +
      "when there is a small set of likely answers so the user can pick one; the user may also type " +
      "their own answer. The tool returns exactly what the user chose or typed.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "the question to put to the user" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "optional list of suggested answers to offer as choices",
        },
      },
      required: ["question"],
    },
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      const question = String(params?.question ?? "").trim();
      if (!question) return text("error: question is required");
      const options = Array.isArray(params?.options)
        ? params.options.map((o: unknown) => String(o)).filter((o: string) => o.length > 0)
        : [];

      const questionId = newQuestionId();
      emit({ type: "ask_user", id: questionId, question, options });

      try {
        const answer = await new Promise<string>((resolve, reject) => {
          registerQuestion(questionId, conversationId, resolve);
          const onAbort = () => {
            cancelQuestion(questionId);
            reject(new Error("aborted"));
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return text(`The user answered: ${JSON.stringify(answer)}`);
      } catch {
        // The run was stopped (or the tab closed, which aborts it) before the
        // user replied. Reported as a plain result rather than a throw — the
        // run is already ending, and a throw would read as a tool failure.
        return text("No answer — the run was stopped before the user responded.");
      }
    },
  };
}
