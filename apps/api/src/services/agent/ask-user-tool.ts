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

type AskUserEvent = Extract<AgentEvent, { type: "ask_user" }>;
export type UserInputRequest = Pick<AskUserEvent, "question" | "options" | "kind">;

/**
 * Why a prompt ended. `timeout` is distinct from `aborted` on purpose: an abort
 * ends the run, but a timeout leaves it running, so the model must be told to
 * carry on rather than that it was stopped.
 */
export type UserInputOutcome =
  | { status: "answered"; answer: string }
  | { status: "aborted" }
  | { status: "timeout" };

export type UserInputRequester = (
  request: UserInputRequest,
  signal?: AbortSignal,
) => Promise<UserInputOutcome>;

export const APPROVAL_OPTIONS = ["Allow once", "Deny"] as const;
export const approvalGranted = (outcome: UserInputOutcome): boolean =>
  outcome.status === "answered" && outcome.answer === APPROVAL_OPTIONS[0];

let counter = 0;
/** Unique per question. Not crypto — it only has to be distinct within a run. */
function newQuestionId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `q_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * One serialized door from a running agent to its human.
 *
 * Pi may execute several tools in parallel. Emitting two questions at once
 * would make the second replace the first in the console, leaving the first
 * call blocked with no button capable of answering it. The queue is per run and
 * shared by ordinary elicitation and enforced approval prompts.
 */
export function createUserInputRequester(
  conversationId: string,
  emit: (event: AgentEvent) => void,
  /**
   * Auto-cancel a prompt left unanswered this long, so a user who walked away
   * cannot wedge the run indefinitely (an approval was measured waiting ~24
   * minutes). 0 or undefined disables the bound. See USER_PROMPT_TIMEOUT_MS.
   */
  timeoutMs?: number,
): UserInputRequester {
  let active = false;
  const waiting: (() => void)[] = [];

  return async (request, signal) => {
    if (active) {
      const entered = await new Promise<boolean>((resolve) => {
        const enter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        };
        const onAbort = () => {
          const index = waiting.indexOf(enter);
          if (index >= 0) waiting.splice(index, 1);
          resolve(false);
        };
        if (signal?.aborted) return onAbort();
        waiting.push(enter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (!entered) return { status: "aborted" };
    } else {
      // Keep the first emission synchronous. Existing callers start execute(),
      // then immediately inspect the emitted event before awaiting the result.
      active = true;
    }
    try {
      if (signal?.aborted) return { status: "aborted" };

      const questionId = newQuestionId();
      emit({
        type: "ask_user",
        id: questionId,
        question: request.question,
        options: request.options,
        kind: request.kind,
      });

      return await new Promise<UserInputOutcome>((resolve) => {
        // Timeout and abort both resolve the *active* prompt so the finally
        // below runs and releases the next queued prompt — a timeout that
        // stranded the queue would be a worse hang than the one it fixes.
        const timer =
          timeoutMs && timeoutMs > 0
            ? setTimeout(() => {
                cancelQuestion(questionId);
                finish({ status: "timeout" });
              }, timeoutMs)
            : undefined;
        (timer as any)?.unref?.();
        const finish = (outcome: UserInputOutcome) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = () => {
          cancelQuestion(questionId);
          finish({ status: "aborted" });
        };

        registerQuestion(questionId, conversationId, (answer) =>
          finish({ status: "answered", answer }),
        );
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active = false;
    }
  };
}

export function createAskUserTool(
  requestInput: UserInputRequester,
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

      const outcome = await requestInput({ question, options, kind: "question" }, signal);
      if (outcome.status === "answered") {
        return text(`The user answered: ${JSON.stringify(outcome.answer)}`);
      }

      // A timeout leaves the run going, so tell the model to continue rather
      // than that it was stopped — and not to just re-ask the same thing.
      if (outcome.status === "timeout") {
        return text(
          "No answer — the prompt timed out and the user did not respond. The run is still going: " +
            "continue with a reasonable assumption or a different approach, and do not repeat the same question.",
        );
      }

      // The run was stopped (or the tab closed, which aborts it) before the
      // user replied. Reported as a plain result rather than a throw — the run
      // is already ending, and a throw would read as a tool failure.
      return text("No answer — the run was stopped before the user responded.");
    },
  };
}
