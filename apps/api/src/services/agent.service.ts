import type { Harness } from "../catalog/harnesses";
import type { ModelConfig } from "../catalog/llm-models";
import { chatOnce } from "./provider.service";
import type { ChatMessage } from "../types/chat";
import type { AgentEvent, AgentOptions } from "../types/agent";
import { runTool, toolSchemas } from "../catalog/tools";
import { logger, startTimer } from "../lib/logger";
import { runPiAgent } from "./pi.service";

/**
 * Runs the harness+model agent loop:
 * system prompt → model (streamed) → execute tool calls → repeat → final answer.
 * Pass `options.signal` to stop mid-loop. Returns the number of turns taken.
 */
export async function runAgent(
  harness: Harness,
  model: ModelConfig,
  history: ChatMessage[],
  emit: (event: AgentEvent) => void,
  { signal, runId = "-", template, workspace, workspaceId }: AgentOptions = {},
): Promise<number> {
  const messages: ChatMessage[] = [
    { role: "user", content: harness.systemPrompt },
    ...history,
  ];
  const tools = toolSchemas();
  let turns = 0;
  const aborted = () => signal?.aborted ?? false;
  const span = (label: string, fields: Record<string, unknown> = {}) => {
    logger.info(label, { run: runId, model: model.id, harness: harness.id, ...fields });
    emit({ type: "trace", step: label, fields: { ...fields, run: runId, model: model.id } });
  };

  if (harness.driver === "pi") {
    return runPiAgent({
      model,
      systemPrompt: harness.systemPrompt,
      harnessTools: harness.tools ?? [],
      history,
      emit,
      signal,
      runId,
      template,
      workspace,
      workspaceId,
    });
  }

  try {
    for (let i = 0; i < harness.maxIterations; i++) {
      if (aborted()) throw new AbortError();
      turns = i + 1;
      emit({ type: "iteration", iteration: turns });

      const t = startTimer();
      const chunk = await chatOnce(model, messages, tools);
      span("llm", { turn: turns, ms: t.elapsed(), text: chunk.text.length, thought: chunk.reasoningContent.length, tools: chunk.toolCalls.length });

      if (chunk.reasoningContent) {
        for (const part of chunk.reasoningContent.match(/.{1,64}/gs) ?? []) {
          emit({ type: "reasoning", delta: part });
        }
      }

      if (chunk.toolCalls.length) {
        const executed = await Promise.all(
          chunk.toolCalls.map(async (tc) => {
            const tt = startTimer();
            const result = await runTool(tc.name, tc.args);
            logger.info("tool", { run: runId, name: tc.name, args: tc.args, ms: tt.elapsed() });
            emit({ type: "trace", step: "tool", fields: { name: tc.name, ms: tt.elapsed() } });
            return { ...tc, result };
          }),
        );
        for (const e of executed) {
          emit({ type: "tool_call", id: e.id, name: e.name, args: e.args });
          emit({ type: "tool_result", name: e.name, content: e.result, calls: executed.length });
        }
        messages.push(...buildToolMessagesFor(executed, chunk.text));
        continue;
      }

      if (chunk.text) {
        for (const part of chunk.text.match(/.{1,64}/gs) ?? []) {
          emit({ type: "text", delta: part });
        }
      }
      emit({ type: "done", turns });
      return turns;
    }
    emit({ type: "text", delta: "\n\n[harness stopped after reaching max iterations]" });
    emit({ type: "done", turns });
    return turns;
  } catch (e) {
    if (e instanceof AbortError) {
      logger.warn("run.abort", { run: runId, turns });
      emit({ type: "text", delta: "\n\n[stopped by user]" });
      emit({ type: "done", turns });
      return turns;
    }
    logger.error("run.error", { run: runId, turns, error: (e as Error).message });
    emit({ type: "error", message: (e as Error).message });
    return turns;
  }
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function buildToolMessagesFor(
  executed: { id: string; name: string; args: Record<string, unknown>; result: string }[],
  text: string,
): ChatMessage[] {
  const out: ChatMessage[] = [
    {
      role: "assistant",
      content: text || undefined,
      tool_calls: executed.map((e) => ({
        id: e.id,
        type: "function",
        function: { name: e.name, arguments: JSON.stringify(e.args) },
      })),
    },
  ];
  for (const e of executed) {
    out.push({ role: "tool", tool_call_id: e.id, name: e.name, content: e.result });
  }
  return out;
}
