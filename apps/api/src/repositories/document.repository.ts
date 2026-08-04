import { and, eq, sql } from "drizzle-orm";
import { db, documents, chunks } from "../db/client";
import type { DocumentRow, DocumentStatus } from "../models/schema";
import type { Chunk } from "../services/chunk.service";

/** A chunk that matched a search, with everything a citation needs. */
export type ScoredChunk = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  page: number;
  seq: number;
  text: string;
  snippet: string;
  score: number; // higher is better
};

export type NewDocument = {
  id: string;
  workspaceId: string;
  title: string;
  bytes: number;
  pages: number;
  status: DocumentStatus;
  error?: string | null;
};

export interface DocumentStore {
  save(doc: NewDocument, docChunks: Chunk[]): Promise<void>;
  list(workspaceId: string): Promise<DocumentRow[]>;
  remove(workspaceId: string, documentId: string): Promise<boolean>;
  search(workspaceId: string, ftsQuery: string, limit: number): Promise<ScoredChunk[]>;
}

/**
 * The only thing that touches `documents`, `chunks`, and `chunks_fts`.
 *
 * `chunks` is the source of truth; `chunks_fts` is a virtual FTS5 mirror of the
 * text used purely for ranking. Both are written in one transaction so the index
 * can never drift from the rows it points at.
 */
export class SqliteDocumentStore implements DocumentStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async save(doc: NewDocument, docChunks: Chunk[]): Promise<void> {
    this.dbImpl.transaction((tx) => {
      tx.insert(documents)
        .values({
          id: doc.id,
          workspaceId: doc.workspaceId,
          title: doc.title,
          bytes: doc.bytes,
          pages: doc.pages,
          chunkCount: docChunks.length,
          status: doc.status,
          error: doc.error ?? null,
          createdAt: Date.now(),
        })
        .run();

      for (const c of docChunks) {
        const chunkId = `${doc.id}-${c.seq}`;
        tx.insert(chunks)
          .values({
            id: chunkId,
            documentId: doc.id,
            workspaceId: doc.workspaceId,
            seq: c.seq,
            page: c.page,
            text: c.text,
          })
          .run();
        tx.run(
          sql`INSERT INTO chunks_fts (text, chunk_id, document_id)
              VALUES (${c.text}, ${chunkId}, ${doc.id})`,
        );
      }
    });
  }

  async list(workspaceId: string): Promise<DocumentRow[]> {
    const rows = await this.dbImpl
      .select()
      .from(documents)
      .where(eq(documents.workspaceId, workspaceId))
      .orderBy(sql`created_at desc`);
    return rows as DocumentRow[];
  }

  async remove(workspaceId: string, documentId: string): Promise<boolean> {
    const owned = await this.dbImpl
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.workspaceId, workspaceId), eq(documents.id, documentId)));
    if (!owned.length) return false;

    this.dbImpl.transaction((tx) => {
      // chunks cascade from documents, but the FTS mirror is a virtual table
      // with no foreign keys — it has to be cleared explicitly.
      tx.run(sql`DELETE FROM chunks_fts WHERE document_id = ${documentId}`);
      tx.delete(documents).where(eq(documents.id, documentId)).run();
    });
    return true;
  }

  /**
   * Rank chunks against a prepared FTS5 query.
   *
   * bm25() returns a negative score where more-negative is a better match; it is
   * negated here so callers can treat "higher is better" as the only convention
   * they need to know.
   */
  async search(workspaceId: string, ftsQuery: string, limit: number): Promise<ScoredChunk[]> {
    const rows = (await this.dbImpl.all(sql`
      SELECT
        c.id           AS chunkId,
        c.document_id  AS documentId,
        d.title        AS docTitle,
        c.page         AS page,
        c.seq          AS seq,
        c.text         AS text,
        snippet(chunks_fts, 0, '[', ']', '…', 24) AS snippet,
        -bm25(chunks_fts) AS score
      FROM chunks_fts
      JOIN chunks    c ON c.id = chunks_fts.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ${ftsQuery}
        AND c.workspace_id = ${workspaceId}
        AND d.status = 'indexed'
      ORDER BY score DESC
      LIMIT ${limit}
    `)) as ScoredChunk[];
    return rows;
  }
}

export const documentStore: DocumentStore = new SqliteDocumentStore();
