import { extractPagesMarkdown } from "@firecrawl/pdf-inspector";
import type { PageText } from "./chunk.service";

/**
 * Bytes -> text per page. The only module that knows what a PDF is.
 *
 * Backed by @firecrawl/pdf-inspector (Rust/NAPI): it returns per-page Markdown
 * with headings, lists and pipe-tables preserved, and reports per page whether
 * the text is trustworthy. Structure matters downstream — chunking splits on
 * paragraph boundaries, so a table that survives as a table stays one coherent
 * passage instead of collapsing into a run of loose numbers.
 *
 * Every future format lands here, and chunking, storage, search, and the agent
 * tool stay untouched.
 */

export type ExtractResult =
  | {
      ok: true;
      pages: PageText[];
      pageCount: number;
      /** Set when some pages were skipped — indexed, but not the whole file. */
      note?: string;
    }
  /** Parsed fine, but no page carried usable text — almost always a scan. */
  | { ok: false; reason: "no-text"; pageCount: number; message: string }
  | { ok: false; reason: "unreadable"; pageCount: 0; message: string };

export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  let result: ReturnType<typeof extractPagesMarkdown>;

  try {
    // The NAPI binding takes a Node Buffer; Buffer.from here is a view, not a copy.
    result = extractPagesMarkdown(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (e: any) {
    // pdf-inspector throws on anything it cannot open, with a specific reason
    // ("Not a PDF: file appears to be plain text"), which is worth surfacing.
    return {
      ok: false,
      reason: "unreadable",
      pageCount: 0,
      message: `could not parse the PDF: ${e?.message ?? String(e)}`,
    };
  }

  const pageCount = result.pages.length;

  // `pages[].page` is 0-indexed; citations are 1-indexed. Pages flagged
  // needsOcr are dropped rather than indexed: their text is garbage when it
  // exists at all, and garbage in the index surfaces as a confident wrong
  // citation later.
  const pages: PageText[] = result.pages
    .filter((p) => !p.needsOcr)
    .map((p) => ({ page: p.page + 1, text: (p.markdown ?? "").trim() }))
    .filter((p) => p.text.length > 0);

  if (!pages.length) {
    const reasons = [...new Set(result.pages.map((p) => p.ocrReason).filter(Boolean))];
    return {
      ok: false,
      reason: "no-text",
      pageCount,
      message:
        `no usable text layer across ${pageCount} page(s)` +
        `${reasons.length ? ` (${reasons.join(", ")})` : ""} — this is usually a scanned ` +
        `PDF, which needs OCR before it can be indexed`,
    };
  }

  // A partly-scanned document is indexed for the pages that worked, and says
  // which ones it could not read. Silently indexing 2 of 10 pages is the failure
  // mode where a user concludes the answer isn't in their documents.
  const skipped = pageCount - pages.length;
  const note = skipped
    ? `${skipped} of ${pageCount} page(s) had no usable text and were skipped ` +
      `(pages ${result.pages.filter((p) => p.needsOcr).map((p) => p.page + 1).join(", ")}) — they need OCR`
    : undefined;

  return { ok: true, pages, pageCount, note };
}
