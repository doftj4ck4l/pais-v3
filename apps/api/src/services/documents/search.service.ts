import { documentStore, type DocumentStore, type ScoredChunk } from "../../repositories/document.repository";

export type { ScoredChunk };

/**
 * Words that match nearly every document and so carry no ranking signal. Kept
 * deliberately short: BM25 already down-weights common terms, so this list only
 * needs to remove the question scaffolding users type ("what is the ...").
 */
const STOPWORDS = new Set([
  "a","an","and","any","are","as","at","be","been","but","by","can","did","do","does",
  "for","from","had","has","have","how","i","if","in","into","is","it","its","me","my",
  "of","on","or","our","out","so","some","tell","that","the","their","them","then",
  "there","these","they","this","to","us","was","we","were","what","when","where",
  "which","who","why","will","with","would","you","your",
]);

/**
 * Turn a natural-language question into a valid FTS5 MATCH expression.
 *
 * This is not cosmetic. FTS5 MATCH is a query language, not a string: an
 * apostrophe, a question mark, or a bare `NOT`/`OR`/`NEAR` in the user's
 * sentence is a syntax error or, worse, a silently different query. Every token
 * is therefore extracted and re-quoted as a literal.
 *
 * Terms are OR-ed rather than AND-ed. AND is precise but returns nothing the
 * moment one word is absent, which is the common case for a question phrased
 * differently from the document. OR keeps recall, and BM25 does the ranking —
 * chunks matching more, rarer terms surface first.
 *
 * Returns null when nothing searchable survives, so callers can say "no usable
 * terms" instead of issuing a query that throws.
 */
/**
 * The searchable words in a query, deduplicated, after stopword removal (with
 * the single-character fallback described in `toFtsQuery`). Shared by the FTS
 * query and by title matching, so both look for the same things.
 */
export function searchTokens(raw: string): string[] {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  // Everything was stopwords or single characters — fall back to every word,
  // keeping one-character tokens this time. That way "who are we?" still
  // searches, and a question about a one-letter subject ("R", "C") is not
  // silently unanswerable.
  const usable = tokens.length
    ? tokens
    : (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

  return [...new Set(usable)];
}

export function toFtsQuery(raw: string): string | null {
  const unique = searchTokens(raw);
  if (!unique.length) return null;
  return unique.map((t) => `"${t}"`).join(" OR ");
}

export type SearchResult =
  | { ok: true; hits: ScoredChunk[]; query: string }
  | { ok: false; reason: "no-terms" };

/** Search one workspace's indexed documents, merging name matches with body matches. */
export async function searchDocuments(
  workspaceId: string,
  rawQuery: string,
  limit = 5,
  store: DocumentStore = documentStore,
): Promise<SearchResult> {
  const query = toFtsQuery(rawQuery);
  if (!query) return { ok: false, reason: "no-terms" };
  const bounded = Math.max(1, Math.min(20, limit || 5));

  // Title hits fill slots the body search does not claim. Without this, a
  // question naming an upload ("what's in Azmin.m4a?") searches the chunks,
  // finds an unrelated passage from the PDF that beat the transcript on BM25,
  // and the model concludes the audio was never indexed.
  //
  // Title tokens are filtered harder than body tokens: LIKE "%we%" over every
  // title would match most of them, so the stopword fallback is not enough.
  const tokens = searchTokens(rawQuery).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const [body, byName] = await Promise.all([
    store.search(workspaceId, query, bounded),
    store.searchByTitle(workspaceId, tokens, bounded),
  ]);

  // A name match ranks first: the user named a document ("Azmin.m4a"), which is
  // a stronger signal than whichever passage scored best on BM25. Body matches
  // fill the slots a name match did not claim.
  const byId = new Map<string, ScoredChunk>();
  for (const hit of byName) byId.set(hit.chunkId, hit);
  for (const hit of body) {
    if (byId.has(hit.chunkId)) continue; // already ranked via title match
    byId.set(hit.chunkId, hit);
  }
  const hits = [...byId.values()].slice(0, bounded);
  return { ok: true, hits, query };
}
