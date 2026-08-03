import { and, eq, sql } from "drizzle-orm";
import { users, conversations, messages, traces, db } from "../db/client";
import type { ConversationRow } from "../db/client";
import type { ConversationStatus } from "../models/schema";

const genId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Conversation repository: CRUD over users / conversations / messages / traces.
 *
 * Model: 1 user -> many conversations -> (many messages + many traces).
 * A conversation corresponds to one agent run: its title is the task, and its
 * status mirrors the agent's lifecycle.
 */
export const conversationRepository = {
  /** Ensure a user row exists (idempotent). */
  async ensureUser(userId: string): Promise<void> {
    await db
      .insert(users)
      .values({ id: userId, createdAt: Date.now() })
      .onConflictDoNothing();
  },

  /** Create a new conversation. Returns its id. */
  async create(input: {
    userId: string;
    title: string;
    modelId: string;
    harnessId: string;
    status?: ConversationStatus;
  }): Promise<string> {
    await this.ensureUser(input.userId);
    const now = Date.now();
    const id = genId("conv");
    await db.insert(conversations).values({
      id,
      userId: input.userId,
      title: input.title,
      modelId: input.modelId,
      harnessId: input.harnessId,
      status: input.status ?? "running",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },

  /** List a user's conversations, newest first. */
  async list(userId: string): Promise<ConversationRow[]> {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(sql`created_at desc`);
  },

  /** Get one conversation by id. */
  async get(conversationId: string): Promise<ConversationRow | undefined> {
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0];
  },

  /**
   * The conversation to continue, or undefined when the id is unknown or owned
   * by someone else. Ownership is checked here rather than by the caller so a
   * forged id cannot append turns to another user's thread.
   */
  async getOwned(conversationId: string, userId: string): Promise<ConversationRow | undefined> {
    const rows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    return rows[0];
  },

  /** Where the next run's rows start, so a follow-up extends the transcript. */
  async nextSeq(conversationId: string): Promise<number> {
    const rows = await db.all<{ next: number | null }>(
      sql`SELECT MAX(seq) + 1 AS next FROM messages WHERE conversation_id = ${conversationId}`,
    );
    return rows[0]?.next ?? 0;
  },

  async setStatus(conversationId: string, status: ConversationStatus): Promise<void> {
    await db
      .update(conversations)
      .set({ status, updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId));
  },

  /** Append a whole transcript in one statement. No-op when empty. */
  async appendMessages(
    conversationId: string,
    rows: { kind: string; seq: number; text: string | null }[],
  ): Promise<void> {
    if (!rows.length) return;
    const ts = Date.now();
    await db.insert(messages).values(
      rows.map((row) => ({
        id: genId("msg"),
        conversationId,
        kind: row.kind,
        seq: row.seq,
        text: row.text,
        ts,
      })),
    );
  },

  /** Append a whole trace in one statement. No-op when empty. */
  async appendTraces(
    conversationId: string,
    rows: { step: string; fields: unknown }[],
  ): Promise<void> {
    if (!rows.length) return;
    const ts = Date.now();
    await db.insert(traces).values(
      rows.map((row) => ({
        id: genId("trc"),
        conversationId,
        step: row.step,
        fields: JSON.stringify(row.fields ?? {}),
        ts,
      })),
    );
  },

  /** List a conversation's messages, in order. */
  async listMessages(conversationId: string) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(sql`seq asc`);
  },

  /** List a conversation's traces, oldest first. */
  async listTraces(conversationId: string) {
    return db
      .select()
      .from(traces)
      .where(eq(traces.conversationId, conversationId))
      .orderBy(sql`ts asc`);
  },

  /** Delete a conversation and its children (FK cascade). */
  async remove(conversationId: string): Promise<void> {
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  },

};
