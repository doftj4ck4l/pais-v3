import { and, eq, sql } from "drizzle-orm";
import { db, transcriptions } from "../db/client";
import type { TranscriptionRow, TranscriptionStatus } from "../models/schema";

export type NewTranscription = {
  id: string;
  workspaceId: string;
  title: string;
  bytes: number;
};

/**
 * The only thing that touches `transcriptions`.
 *
 * The table is a job log plus the immediate status of each one: the audio
 * bytes never live in SQLite (they are read into the API process for the
 * whisper call and dropped), so a job cannot be resumed by a later process —
 * a restart marks every in-flight row `failed`, exactly as runs are closed
 * out. The transcript that succeeds is linked by `document_id`, because a
 * `documents` row alone cannot tell a transcript from a PDF upload.
 */
export interface TranscriptionStore {
  create(input: NewTranscription, at?: number): Promise<TranscriptionRow>;
  markTranscribing(id: string, at?: number): Promise<void>;
  markDone(id: string, documentId: string, model: string, transcriptText: string, at?: number): Promise<void>;
  markFailed(id: string, error: string, at?: number): Promise<void>;
  list(workspaceId: string): Promise<TranscriptionRow[]>;
  /** A single job within one workspace; the caller owns the workspace check. */
  get(workspaceId: string, id: string): Promise<TranscriptionRow | undefined>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  /** Close rows orphaned by a previous API process before accepting traffic. */
  stopInterrupted(at?: number): Promise<number>;
}

export class SqliteTranscriptionStore implements TranscriptionStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(input: NewTranscription, at = Date.now()): Promise<TranscriptionRow> {
    const row = {
      id: input.id,
      workspaceId: input.workspaceId,
      title: input.title,
      bytes: input.bytes,
      status: "queued" as TranscriptionStatus,
      model: null,
      error: null,
      documentId: null,
      transcriptText: null,
      createdAt: at,
      updatedAt: at,
    };
    this.dbImpl.insert(transcriptions).values(row).run();
    return row as TranscriptionRow;
  }

  private async set(
    id: string,
    patch: Partial<{
      status: TranscriptionStatus;
      model: string | null;
      error: string | null;
      documentId: string | null;
      transcriptText: string | null;
    }>,
    at = Date.now(),
  ): Promise<void> {
    this.dbImpl.update(transcriptions).set({ ...patch, updatedAt: at }).where(eq(transcriptions.id, id)).run();
  }

  async markTranscribing(id: string, at?: number): Promise<void> {
    await this.set(id, { status: "transcribing" }, at);
  }

  async markDone(id: string, documentId: string, model: string, transcriptText: string, at?: number): Promise<void> {
    await this.set(id, { status: "done", documentId, model, transcriptText }, at);
  }

  async markFailed(id: string, error: string, at?: number): Promise<void> {
    await this.set(id, { status: "failed", error }, at);
  }

  async list(workspaceId: string): Promise<TranscriptionRow[]> {
    const rows = await this.dbImpl
      .select()
      .from(transcriptions)
      .where(eq(transcriptions.workspaceId, workspaceId))
      .orderBy(sql`created_at desc`);
    return rows as TranscriptionRow[];
  }

  async get(workspaceId: string, id: string): Promise<TranscriptionRow | undefined> {
    const rows = await this.dbImpl
      .select()
      .from(transcriptions)
      .where(and(eq(transcriptions.workspaceId, workspaceId), eq(transcriptions.id, id)))
      .limit(1);
    return rows[0] as TranscriptionRow | undefined;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const changed = this.dbImpl
      .delete(transcriptions)
      .where(and(eq(transcriptions.id, id), eq(transcriptions.workspaceId, workspaceId)))
      .returning({ id: transcriptions.id })
      .get();
    return Boolean(changed);
  }

  async stopInterrupted(at = Date.now()): Promise<number> {
    const found = await this.dbImpl
      .select({ count: sql<number>`count(*)` })
      .from(transcriptions)
      .where(sql`status IN ('queued', 'transcribing')`);
    const count = Number(found[0]?.count ?? 0);
    if (!count) return 0;

    await this.dbImpl
      .update(transcriptions)
      .set({ status: "failed", error: "API restarted before this transcription completed.", updatedAt: at })
      .where(sql`status IN ('queued', 'transcribing')`);
    return count;
  }
}

export const transcriptionStore: TranscriptionStore = new SqliteTranscriptionStore();
