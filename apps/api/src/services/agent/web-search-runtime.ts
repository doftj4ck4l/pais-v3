const CACHE_TTL_MS = 10 * 60_000;

// Public keyless search backends rate-limit by egress IP, not by workspace.
// Keep one process-wide lane so parallel agents cannot stampede the same host.
let searchLane: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = searchLane.then(operation, operation);
  searchLane = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
function cacheable(output: string): boolean {
  const value = output.trimStart().toLowerCase();
  return !(
    value.startsWith("error:") ||
    value.startsWith("error running skill") ||
    /^skill ["'].+?["'] exited /.test(value)
  );
}

/**
 * One run's web-search caller.
 *
 * The cache is deliberately run-local: identical public queries in one agent
 * should not hit a scraper twice, while keeping query text out of shared
 * cross-tenant state. The serialization lane remains process-wide because the
 * remote services see every workspace as the same source IP.
 */
export function createWebSearchRunner(
  invoke: (query: string) => Promise<string>,
  options: { now?: () => number; ttlMs?: number } = {},
): (query: string) => Promise<string> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, { output: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  return async (rawQuery: string) => {
    const query = rawQuery.trim().replace(/\s+/g, " ");
    const cached = cache.get(query);
    if (cached && cached.expiresAt > now()) return cached.output;
    if (cached) cache.delete(query);

    const existing = inFlight.get(query);
    if (existing) return existing;

    const pending = serialize(() => invoke(query));
    inFlight.set(query, pending);
    try {
      const output = await pending;
      if (cacheable(output)) cache.set(query, { output, expiresAt: now() + ttlMs });
      return output;
    } finally {
      inFlight.delete(query);
    }
  };
}
