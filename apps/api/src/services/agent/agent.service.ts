import type { Harness } from "../../catalog/harnesses";
import type { ModelConfig } from "../../catalog/llm-models";
import type { ChatMessage } from "../../types/chat";
import type { AgentEvent, AgentOptions } from "../../types/agent";
import { runPiAgent } from "./pi.service";

/**
 * Turns a harness into a run.
 *
 * This is the only thing that turns the catalog's unified system prompt into
 * `runPiAgent` arguments. The runtime discovers workspace capabilities itself;
 * the controller therefore needs to know about neither prompts nor resources.
 *
 * It used to hold a second agent loop as well, reached when `harness.driver`
 * was anything but "pi". Every harness the catalog shipped was "pi", so that
 * loop had been unreachable for as long as it had existed, while still
 * appearing in searches as the place a run happens. `pi.service.ts` is where a
 * run happens.
 */
export async function runAgent(
  harness: Harness,
  model: ModelConfig,
  history: ChatMessage[],
  emit: (event: AgentEvent) => void,
  {
    signal,
    runId = "-",
    template,
    workspace,
    workspaceId,
    conversationId,
    reasoningEffort,
  }: AgentOptions = {},
): Promise<number> {
  return runPiAgent({
    model,
    systemPrompt: harness.systemPrompt,
    history,
    emit,
    signal,
    runId,
    template,
    workspace,
    workspaceId,
    conversationId,
    reasoningEffort,
  });
}
