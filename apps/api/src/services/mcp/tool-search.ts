/**
 * Ranking over the cached MCP tool catalog.
 *
 * A single Nextcloud server advertises 151 tools. Their schemas alone are 36,512
 * tokens — measured, not estimated: it is the floor every `context.usage` span
 * reports on the first turn of every run, 30% of a 123k window spent before the
 * user has typed anything. Across 22 runs, 29 of those 151 tools were ever
 * called, so five sixths of that floor advertised tools nothing has ever used.
 *
 * The fix is Anthropic's tool-search pattern (`defer_loading` + a search tool),
 * done client-side: register the whole catalog with the harness but activate a
 * handful, and let the model widen the set on demand. Only active tools are
 * built into the request, so the rest are free.
 *
 * This module is the ranking half, and it is deliberately pure — no database,
 * no connection. The catalog already lives in `mcp_capabilities`, schemas
 * included, so discovery never needs to talk to a server.
 */

/** One searchable tool: what the model would see if it were active. */
export type ToolDoc = {
  /** The namespaced name the model calls, e.g. `nextcloud__nc_webdav_read_file`. */
  name: string;
  description: string;
  /** Argument names from the tool's input schema. */
  args: string[];
};

export type ToolMatch = { name: string; description: string; score: number };

/**
 * Field weights, applied by repeating a field's tokens.
 *
 * The name carries the most signal and the least noise: `nc_webdav_read_file`
 * is three useful terms, while a description is a sentence written for a human.
 * Arguments are weighted at all because a query like "upload by path" often
 * matches only a parameter name.
 */
const NAME_WEIGHT = 3;
const ARG_WEIGHT = 1;

/** Standard BM25 constants. Nothing here justified tuning them. */
const K1 = 1.2;
const B = 0.75;

/**
 * Words too common in a tool catalog to discriminate.
 *
 * Not a general English stoplist — these are the terms that appear in a large
 * fraction of MCP tool descriptions specifically ("Get the ...", "the tool
 * that ..."), where matching them ranks by verbosity rather than relevance.
 */
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "get", "in",
  "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "with",
]);

/**
 * Strip a plural suffix, and nothing else.
 *
 * Not a real stemmer on purpose. The mismatch that actually costs matches here
 * is singular/plural: a model asks to "read a file" against a description that
 * says "Read the contents of a file" but a tool named `list_files`, and without
 * this "file" and "files" are unrelated terms. `search for a file by its name`
 * ranked `nc_notes_search_notes` first for exactly that reason.
 *
 * Anything more aggressive (Porter, say) would start conflating terms that
 * matter in this catalog — `share` and `shared`, `list` and `listing`.
 */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** Lowercase alphanumeric runs, so `nc_webdav_read_file` yields four terms. */
function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

type Indexed = {
  doc: ToolDoc;
  /** Term -> frequency within this document. */
  tf: Map<string, number>;
  length: number;
};

export type ToolIndex = {
  docs: Indexed[];
  /** Term -> how many documents contain it. */
  df: Map<string, number>;
  avgLength: number;
};

export function buildIndex(docs: ToolDoc[]): ToolIndex {
  const df = new Map<string, number>();
  const indexed: Indexed[] = [];

  for (const doc of docs) {
    const terms = [
      ...repeat(tokenize(doc.name), NAME_WEIGHT),
      ...tokenize(doc.description),
      ...repeat(doc.args.flatMap(tokenize), ARG_WEIGHT),
    ];
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    indexed.push({ doc, tf, length: terms.length });
  }

  const totalLength = indexed.reduce((sum, d) => sum + d.length, 0);
  return {
    docs: indexed,
    df,
    // Guard the empty catalog: avgLength divides in the BM25 denominator.
    avgLength: indexed.length ? totalLength / indexed.length : 1,
  };
}

function repeat(terms: string[], times: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < times; i++) out.push(...terms);
  return out;
}

/**
 * BM25, plus a substring fallback.
 *
 * The fallback matters more than it looks. BM25 scores whole terms, so a query
 * of "webdav" ranks correctly but "web" — which a model writing a search query
 * will produce — matches nothing at all. Returning zero results invites the
 * model to give up and answer from memory, which is the failure this whole
 * mechanism exists to avoid. Fallback hits score below every real BM25 hit.
 */
export function searchTools(index: ToolIndex, query: string, limit = 5): ToolMatch[] {
  const terms = tokenize(query);
  if (!terms.length || !index.docs.length) return [];

  const total = index.docs.length;
  const scored: ToolMatch[] = [];

  for (const entry of index.docs) {
    let score = 0;
    for (const term of terms) {
      const tf = entry.tf.get(term) ?? 0;
      if (!tf) continue;
      const docFreq = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (total - docFreq + 0.5) / (docFreq + 0.5));
      const norm = 1 - B + (B * entry.length) / index.avgLength;
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }

    if (score === 0) {
      // Prefix/substring rescue, scaled far below any real hit so it only ever
      // fills out a result list rather than displacing a genuine match.
      const haystack = `${entry.doc.name} ${entry.doc.description}`.toLowerCase();
      const partial = terms.filter((t) => haystack.includes(t)).length;
      if (!partial) continue;
      score = (partial / terms.length) * 1e-3;
    }

    scored.push({ name: entry.doc.name, description: entry.doc.description, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit));
}

/**
 * The tools to keep active from the start, chosen from what this workspace has
 * actually called before.
 *
 * The alternative was a hand-curated allowlist, which someone has to maintain
 * and which is wrong the moment a workflow changes. The traces table already
 * records every call, so the workspace's own history is a better allowlist than
 * anyone would write — and it needs no UI.
 *
 * A workspace with no history gets an empty core set and searches first. That
 * is the honest cold start: nothing is known about what it needs yet, and
 * guessing would advertise the same untouched tools this exists to remove.
 *
 * `available` filters out tools a server has since stopped advertising, so a
 * stale trace cannot activate a name the harness does not have — pi rejects an
 * unknown name in `setActiveTools` and would fail the run.
 */
export function coreToolNames(
  usage: { name: string; calls: number }[],
  available: Set<string>,
  limit: number,
): string[] {
  return usage
    .filter((u) => available.has(u.name))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map((u) => u.name);
}

/** Argument names from a stored `inputSchema`, for the index and nothing else. */
export function argNamesOf(schemaJson: string | null | undefined): string[] {
  if (!schemaJson) return [];
  try {
    const parsed = JSON.parse(schemaJson) as { properties?: Record<string, unknown> };
    const props = parsed?.properties;
    return props && typeof props === "object" ? Object.keys(props) : [];
  } catch {
    // A malformed schema costs this tool its argument terms, not the index.
    return [];
  }
}
