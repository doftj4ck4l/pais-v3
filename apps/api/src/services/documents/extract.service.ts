import { extractText } from "unpdf";
import type { PageText } from "./chunk.service";

/**
 * Bytes -> text per page. The only module that knows what a PDF is.
 *
 * Uses @firecrawl/pdf-inspector when its native binding exists: it returns
 * per-page Markdown with headings, lists and pipe-tables preserved. Linux ARM64
 * has no published binding, so that platform falls back to unpdf's portable
 * PDF.js extractor instead of preventing the entire API from starting.
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

type ExtractedPage = {
  page: number;
  text: string;
  needsOcr: boolean;
  ocrReason?: string;
};

type NativePdfExtractor =
  (typeof import("@firecrawl/pdf-inspector"))["extractPagesMarkdown"];

let nativePdfExtractor: Promise<NativePdfExtractor | null> | undefined;

function loadNativePdfExtractor(): Promise<NativePdfExtractor | null> {
  nativePdfExtractor ??= import("@firecrawl/pdf-inspector")
    .then(({ extractPagesMarkdown }) => extractPagesMarkdown)
    .catch((error) => {
      if (error instanceof Error && error.message.includes("Cannot find native binding")) {
        return null;
      }
      nativePdfExtractor = undefined;
      throw error;
    });
  return nativePdfExtractor;
}

async function extractPages(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const extractPagesMarkdown = await loadNativePdfExtractor();
  if (extractPagesMarkdown) {
    const result = extractPagesMarkdown(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    return result.pages.map((page) => ({
      page: page.page,
      text: page.markdown ?? "",
      needsOcr: page.needsOcr,
      ...(page.ocrReason ? { ocrReason: page.ocrReason } : {}),
    }));
  }

  const result = await extractText(bytes, { mergePages: false });
  return result.text.map((text, page) => ({
    page,
    text,
    needsOcr: text.trim().length === 0,
    ...(text.trim().length === 0 ? { ocrReason: "no text layer" } : {}),
  }));
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  let extractedPages: ExtractedPage[];

  try {
    extractedPages = await extractPages(bytes);
  } catch (e: any) {
    return {
      ok: false,
      reason: "unreadable",
      pageCount: 0,
      message: `could not parse the PDF: ${e?.message ?? String(e)}`,
    };
  }

  const pageCount = extractedPages.length;

  // `pages[].page` is 0-indexed; citations are 1-indexed. Pages flagged
  // needsOcr are dropped rather than indexed: their text is garbage when it
  // exists at all, and garbage in the index surfaces as a confident wrong
  // citation later.
  const pages: PageText[] = extractedPages
    .filter((p) => !p.needsOcr)
    .map((p) => ({ page: p.page + 1, text: p.text.trim() }))
    .filter((p) => p.text.length > 0);

  if (!pages.length) {
    const reasons = [...new Set(extractedPages.map((p) => p.ocrReason).filter(Boolean))];
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
      `(pages ${extractedPages.filter((p) => p.needsOcr).map((p) => p.page + 1).join(", ")}) — they need OCR`
    : undefined;

  return { ok: true, pages, pageCount, note };
}
