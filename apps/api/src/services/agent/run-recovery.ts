import { conversationRepository } from "../../repositories/conversation.repository";
import { runRepository } from "../../repositories/run.repository";
import { logger } from "../../lib/logger";

/**
 * A new API process cannot own work left in `running` by its predecessor.
 * Close those rows before the server begins listening so the persisted UI and
 * admin ledger describe terminal history rather than phantom live work.
 */
export async function recoverInterruptedRuns(at = Date.now()): Promise<{
  runs: number;
  conversations: number;
}> {
  const runs = await runRepository.stopInterrupted(at);
  const conversations = await conversationRepository.stopInterrupted(at);

  if (runs || conversations) {
    logger.warn("run.recovered", { runs, conversations });
  }
  return { runs, conversations };
}
