import type { Harness } from "../../catalog/harnesses";
import type { ModelConfig } from "../../catalog/llm-models";
import type { ChatMessage } from "../../types/chat";
import type { AgentEvent, AgentOptions } from "../../types/agent";
import { runPiAgent } from "./pi.service";

/**
 * Turns a harness into a run.
 *
 * This is the only thing that knows a harness is a system prompt plus a set of
 * tool groups; `pi.service` takes those and nothing about catalogs, and the
 * controller takes neither. It is a thin seam on purpose — it exists so the
 * controller does not have to unpack a catalog entry, not to make decisions.
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
  { signal, runId = "-", template, workspace, workspaceId }: AgentOptions = {},
): Promise<number> {
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
