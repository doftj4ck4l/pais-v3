/**
 * Page text -> retrievable chunks. Pure: no I/O, no database, no PDF knowledge,
 * so the boundary conditions that make chunking fiddly can be tested with plain
 * strings.
 */

export type PageText = { page: number; text: string };

export type Chunk = {
  seq: number; // order within the document
  page: number; // 1-based, carried into citations
  text: string;
};

export const MAX_CHARS = 1000;
export const OVERLAP_CHARS = 150;

/** Collapse the ragged whitespace PDF extraction produces, keeping paragraphs. */
function normalise(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The tail of a chunk, to prepend to the next one. Snapped to a word boundary so
 * overlap never begins mid-word — a half-word would be indexed as a junk token.
 */
function tailOf(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const cut = tail.search(/\s/);
  return cut === -1 ? tail : tail.slice(cut + 1);
}

/** Split an oversized paragraph on sentence ends, then hard-split what's left. */
function splitLong(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+[\s"')\]]*|[^.!?]+$/g) ?? [paragraph];
  const out: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };

  for (const sentence of sentences) {
    // A single sentence longer than the budget: hard-split it. Rare (tables,
    // OCR runs, minified text) but it must not produce an over-long chunk.
    if (sentence.length > maxChars) {
      flush();
      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (buf.length + sentence.length > maxChars) flush();
    buf += sentence;
  }
  flush();
  return out.filter(Boolean);
}

/**
 * Chunk a document's pages.
 *
 * Chunks never span a page boundary. A chunk maps to exactly one page, so the
 * `[doc.pdf p.4]` citation it produces is always true. The cost is recall when
 * an answer straddles a page break — accepted deliberately, because a citation
 * that points at the wrong page is worse than one extra search.
 */
export function chunkPages(
  pages: PageText[],
  opts: { maxChars?: number; overlap?: number } = {},
): Chunk[] {
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const overlap = opts.overlap ?? OVERLAP_CHARS;
  const chunks: Chunk[] = [];
  let seq = 0;

  for (const { page, text } of pages) {
    const clean = normalise(text);
    if (!clean) continue;

    const paragraphs = clean.split(/\n{2,}/).flatMap((p) => {
      const t = p.trim();
      if (!t) return [];
      return t.length > maxChars ? splitLong(t, maxChars) : [t];
    });

    let buf = "";
    const flush = () => {
      const body = buf.trim();
      if (!body) return;
      chunks.push({ seq: seq++, page, text: body });
      // Carry the tail forward so a passage split across the boundary is still
      // findable from either side.
      buf = overlap > 0 ? tailOf(body, overlap) + "\n\n" : "";
    };

    for (const paragraph of paragraphs) {
      if (buf.trim() && buf.length + paragraph.length > maxChars) flush();
      buf += (buf && !buf.endsWith("\n\n") ? "\n\n" : "") + paragraph;
    }
    flush();
    buf = "";
  }

  return chunks;
}
