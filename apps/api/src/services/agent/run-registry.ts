/**
 * In-process map of a running conversation to the controller that cancels it.
 *
 * The pi run is driven inside this API process, so stopping it is a local
 * `AbortController.abort()`, not a message to anywhere else. The map is keyed by
 * `conversationId` because that is the only run identifier the client is ever
 * given — the server's `runId` never leaves the process, so a stop request has
 * nothing else to name.
 *
 * This exists because a client cannot stop a run by hanging up: on the Bun this
 * repo ships, a disconnect is not bridged to the request's `AbortSignal`, so the
 * stop button posts here instead and this fires the abort directly.
 */

const runs = new Map<string, AbortController>();

export function registerRun(conversationId: string, controller: AbortController): void {
  runs.set(conversationId, controller);
}

/**
 * Drop this run's entry, but only if it is still the current one.
 *
 * A fast follow-up turn on the same conversation can register its own controller
 * before the previous turn's `finally` runs — clearing unconditionally would
 * unregister the live run and leave its stop button dead.
 */
export function unregisterRun(conversationId: string, controller: AbortController): void {
  if (runs.get(conversationId) === controller) runs.delete(conversationId);
}

/** Abort the run for this conversation. Returns false if nothing was running. */
export function abortRun(conversationId: string): boolean {
  const controller = runs.get(conversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}
