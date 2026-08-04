import { documentStore, type DocumentStore } from "../repositories/document.repository";
import type { DocumentStatus } from "../models/schema";
import { chunkPages } from "./chunk.service";
import { extractPdf } from "./extract.service";
import { logger } from "../lib/logger";

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
      { id: documentId, workspaceId, title, bytes: byteLength, pages: extracted.pageCount, status, error: extracted.message },
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
