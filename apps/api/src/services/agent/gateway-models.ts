/**
 * What the configured gateway is actually serving right now.
 *
 * The model catalog in `catalog/llm-models.ts` is a hand-maintained list of
 * every model any of our deployments has ever pointed at. On a fresh on-prem
 * machine that list is wrong in both directions: it advertises gateway models
 * this box has never heard of (shown greyed as "needs a key") and, worse, a
 * couple of hardcoded LAN endpoints that read as ready when nothing answers
 * them. The picker should follow the machine, so we ask the gateway's
 * OpenAI-compatible `GET /v1/models` what it serves and let `getMeta` show only
 * that.
 *
 * Discovery is best-effort and cached, never in a request's critical path:
 * `getMeta` reads the last successful snapshot synchronously and kicks off a
 * refresh when it is stale. A gateway that cannot be reached — or one whose
 * key forbids the models route, as our shared upstream gateway does — simply
 * leaves the snapshot null, and the caller falls back to the single configured
 * `CUSTOM_MODEL`, which is exactly right for the single-model on-prem case.
 */

/** Served model name → its usable context window, when the gateway reports one. */
export type ServedModels = Map<string, number | undefined>;

const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_500;

let snapshot: { models: ServedModels; at: number } | null = null;
let inflight: Promise<void> | null = null;

function gatewayBase(): string {
  // Same default as catalog/llm-models.ts, so an unconfigured dev box probes the
  // same place the catalog would call.
  return (process.env.CUSTOM_BASE_URL ?? "http://60.51.17.97:9999/v1").replace(/\/+$/, "");
}

/** The last successful discovery, or null if the gateway has not answered yet. */
export function servedModels(): ServedModels | null {
  return snapshot?.models ?? null;
}

/**
 * Kick off a refresh if the snapshot is missing or stale. Fire-and-forget: the
 * result lands in the module cache for the next `getMeta`, so this never blocks
 * the response that triggered it. A single in-flight request is de-duplicated.
 */
export function maybeRefreshServedModels(
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): void {
  if (snapshot && now - snapshot.at < TTL_MS) return;
  if (inflight) return;
  inflight = refreshServedModels(fetcher).finally(() => {
    inflight = null;
  });
}

/** Fetch and store the served set. Errors keep the previous snapshot. */
export async function refreshServedModels(fetcher: typeof fetch = fetch): Promise<void> {
  const models = await fetchServedModels(fetcher);
  if (models) snapshot = { models, at: Date.now() };
}

async function fetchServedModels(fetcher: typeof fetch): Promise<ServedModels | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const key = process.env.CUSTOM_API_KEY?.trim();
    const res = await fetcher(`${gatewayBase()}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    const data = Array.isArray(body?.data) ? body.data : [];
    const models: ServedModels = new Map();
    for (const entry of data as Array<Record<string, unknown>>) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id) continue;
      // vLLM reports the true window as max_model_len; keep it so the console's
      // context meter is measured rather than the catalog's guess.
      const len = entry?.max_model_len;
      models.set(id, typeof len === "number" && len > 0 ? len : undefined);
    }
    return models.size ? models : null;
  } catch {
    // Best-effort: an unreachable gateway or a forbidden models route leaves the
    // snapshot untouched and the caller falls back to the configured model.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: force a known snapshot (or clear it) without a real gateway. */
export function __setServedModelsForTest(models: ServedModels | null): void {
  snapshot = models ? { models, at: Date.now() } : null;
  inflight = null;
}
