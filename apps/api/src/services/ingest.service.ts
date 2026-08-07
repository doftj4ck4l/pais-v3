import { documentStore, type DocumentStore } from "../repositories/document.repository";
import type { DocumentStatus } from "../models/schema";
import { chunkPages, type PageText } from "./chunk.service";
import { extractPdf } from "./extract.service";
import { logger } from "../lib/logger";

/**
 * Where a document came from, when it did not come from an upload.
 *
 * Carried through ingestion rather than patched on afterwards, so a document
 * and its provenance are written in the same transaction — a row that exists
 * without knowing which connector owns it cannot be re-synced or cleaned up.
 */
export type DocumentSource = {
  connectorId: string;
  externalId: string;
  externalVersion: string;
  externalUrl?: string | null;
};

const newDocId = () => `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export type IngestResult = {
  documentId: string;
  title: string;
  status: DocumentStatus;
  pages: number;
  chunks: number;
  /** Present when status is not `indexed` — shown verbatim in the UI. */
  error?: string;
};

/**
 * Ingest one uploaded file: extract -> chunk -> store.
 *
 * A file that cannot be indexed is still recorded, with the reason. The user
 * uploaded it and needs to see what happened to it; dropping the row would make
 * a failed upload indistinguishable from one that never arrived.
 */
export async function ingestPdf(
  workspaceId: string,
  title: string,
  bytes: Uint8Array,
  store: DocumentStore = documentStore,
  source?: DocumentSource,
): Promise<IngestResult> {
  const documentId = newDocId();
  // Read the size before extracting. The current extractor leaves the buffer
  // intact, but pdfjs (used previously) detached it and silently turned every
  // recorded size into 0 — cheap to stay independent of that choice.
  const byteLength = bytes.length;
  const extracted = await extractPdf(bytes);

  if (!extracted.ok) {
    const status: DocumentStatus = extracted.reason === "no-text" ? "empty" : "error";
    await store.save(
      { id: documentId, workspaceId, title, bytes: byteLength, pages: extracted.pageCount, status, error: extracted.message, ...source },
      [],
    );
    logger.warn("ingest.rejected", { documentId, title, status, reason: extracted.reason });
    return { documentId, title, status, pages: extracted.pageCount, chunks: 0, error: extracted.message };
  }

  const docChunks = chunkPages(extracted.pages);
  await store.save(
    {
      id: documentId,
      workspaceId,
      title,
      bytes: byteLength,
      pages: extracted.pageCount,
      status: "indexed",
      // A partial extraction is a success worth qualifying, so the note rides
      // in the same field the UI already renders for a document's problems.
      error: extracted.note ?? null,
      ...source,
    },
    docChunks,
  );
  logger.info("ingest.indexed", {
    documentId,
    title,
    pages: extracted.pageCount,
    chunks: docChunks.length,
    ...(extracted.note ? { note: extracted.note } : {}),
  });

  return {
    documentId,
    title,
    status: "indexed",
    pages: extracted.pageCount,
    chunks: docChunks.length,
    ...(extracted.note ? { error: extracted.note } : {}),
  };
}

/**
 * Ingest text that needed no extraction: chunk -> store.
 *
 * A Google Doc arrives as Markdown and a Sheet as CSV, because the source
 * exports them that way — running either through `extractPdf` would be asking
 * a PDF parser to read something that was never a PDF. The two paths converge
 * at `chunkPages`, which is the point everything downstream depends on.
 *
 * Everything without inherent pagination is one page. Citations then read
 * "[Roadmap p.1]", which is honest: the passage is in that document, and the
 * document has no page 2 to be wrong about.
 */
export async function ingestText(
  workspaceId: string,
  title: string,
  text: string,
  store: DocumentStore = documentStore,
  source?: DocumentSource,
): Promise<IngestResult> {
  const documentId = newDocId();
  const bytes = Buffer.byteLength(text, "utf8");
  const trimmed = text.trim();

  if (!trimmed) {
    // Recorded, not dropped. An empty Google Doc and a file that failed to
    // export are different problems, and only the row can tell them apart.
    const message = "the file exported no text";
    await store.save(
      { id: documentId, workspaceId, title, bytes, pages: 0, status: "empty", error: message, ...source },
      [],
    );
    return { documentId, title, status: "empty", pages: 0, chunks: 0, error: message };
  }

  const pages: PageText[] = [{ page: 1, text: trimmed }];
  const docChunks = chunkPages(pages);
  await store.save(
    { id: documentId, workspaceId, title, bytes, pages: 1, status: "indexed", error: null, ...source },
    docChunks,
  );
  logger.info("ingest.indexed", { documentId, title, pages: 1, chunks: docChunks.length });

  return { documentId, title, status: "indexed", pages: 1, chunks: docChunks.length };
}
