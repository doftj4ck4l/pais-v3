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
export function toFtsQuery(raw: string): string | null {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  // Everything was stopwords or single characters — fall back to every word,
  // keeping one-character tokens this time. That way "who are we?" still
  // searches, and a question about a one-letter subject ("R", "C") is not
  // silently unanswerable.
  const usable = tokens.length
    ? tokens
    : (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

  if (!usable.length) return null;
  const unique = [...new Set(usable)];
  return unique.map((t) => `"${t}"`).join(" OR ");
}

export type SearchResult =
  | { ok: true; hits: ScoredChunk[]; query: string }
  | { ok: false; reason: "no-terms" };

/** Search one workspace's indexed documents. */
export async function searchDocuments(
  workspaceId: string,
  rawQuery: string,
  limit = 5,
  store: DocumentStore = documentStore,
): Promise<SearchResult> {
  const query = toFtsQuery(rawQuery);
  if (!query) return { ok: false, reason: "no-terms" };
  const bounded = Math.max(1, Math.min(20, limit || 5));
  const hits = await store.search(workspaceId, query, bounded);
  return { ok: true, hits, query };
}
