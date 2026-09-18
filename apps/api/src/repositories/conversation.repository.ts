import { and, eq, sql } from "drizzle-orm";
import { conversations, messages, traces, db } from "../db/client";
import type { ConversationRow } from "../db/client";
import type { ConversationStatus } from "../models/schema";

const genId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Conversation repository: CRUD over users / conversations / messages / traces.
 *
 * Model: 1 workspace -> many conversations -> (many messages + many traces).
 * A conversation corresponds to one agent run: its title is the task, and its
 * status mirrors the agent's lifecycle.
 */
export const conversationRepository = {
  /** Create a new conversation. Returns its id. */
  async create(input: {
    workspaceId: string;
    title: string;
    modelId: string;
    harnessId: string;
    status?: ConversationStatus;
  }): Promise<string> {
    const now = Date.now();
    const id = genId("conv");
    await db.insert(conversations).values({
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      modelId: input.modelId,
      harnessId: input.harnessId,
      status: input.status ?? "running",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },

  /** List a workspace's conversations, newest first. */
  async list(workspaceId: string): Promise<ConversationRow[]> {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.workspaceId, workspaceId))
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
   * The conversation to continue, or undefined when the id is unknown or held
   * by another workspace. Ownership is checked here rather than by the caller
   * so a forged id cannot append turns to someone else's thread — the
   * workspace itself has already been proved to belong to the user by
   * `workspaceRegistry.resolve`.
   */
  async getOwned(
    conversationId: string,
    workspaceId: string,
  ): Promise<ConversationRow | undefined> {
    const rows = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)),
      )
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

  /** Pin or unpin only when the conversation belongs to the resolved workspace. */
  async setPinned(
    conversationId: string,
    workspaceId: string,
    pinned: boolean,
    dbImpl: typeof db = db,
  ): Promise<ConversationRow | undefined> {
    const rows = await dbImpl
      .update(conversations)
      .set({ pinned })
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)),
      )
      .returning();
    return rows[0];
  },

  /** Mirror startup recovery on conversation rows orphaned by a dead process. */
  async stopInterrupted(at = Date.now(), dbImpl: typeof db = db): Promise<number> {
    const found = await dbImpl
      .select({ count: sql<number>`count(*)` })
      .from(conversations)
      .where(eq(conversations.status, "running"));
    const count = Number(found[0]?.count ?? 0);
    if (!count) return 0;

    await dbImpl
      .update(conversations)
      .set({ status: "stopped", updatedAt: at })
      .where(eq(conversations.status, "running"));
    return count;
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

  /**
   * Append a run's spans in one statement. No-op when empty.
   *
   * Each row carries the timestamp it was recorded with. This used to stamp the
   * whole batch with a single `Date.now()` at flush time, which put every span
   * in a run at the same instant — fine for a flat list, useless for a
   * timeline, and the reason the waterfall needed this fixed first.
   */
  async appendTraces(
    conversationId: string,
    rows: { step: string; fields: unknown; ts?: number; durationMs?: number }[],
    runId?: string,
  ): Promise<void> {
    if (!rows.length) return;
    const fallbackTs = Date.now();
    await db.insert(traces).values(
      rows.map((row) => ({
        id: genId("trc"),
        conversationId,
        runId: runId ?? null,
        step: row.step,
        fields: JSON.stringify(row.fields ?? {}),
        ts: row.ts ?? fallbackTs,
        durationMs: row.durationMs ?? 0,
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

  /**
   * Every tool call this workspace has made, newest first, with the
   * conversation that made it.
   *
   * One query rather than a listing per conversation: the caller is answering
   * "which chat wrote this file" for a whole directory at once, and doing that
   * per file would be a query per file. Bounded because it is read on a page
   * load and the answer only gets less interesting the further back it goes.
   */
  async listToolCalls(
    workspaceId: string,
    limit = 2000,
  ): Promise<{ conversationId: string; title: string; ts: number; text: string }[]> {
    const rows = await db
      .select({
        conversationId: messages.conversationId,
        title: conversations.title,
        ts: messages.ts,
        text: messages.text,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.workspaceId, workspaceId), eq(messages.kind, "tool")))
      .orderBy(sql`messages.ts desc, messages.seq desc`)
      .limit(limit);
    return rows.filter((r): r is typeof r & { text: string } => r.text !== null);
  },

  /** List a conversation's traces, oldest first. */
  async listTraces(conversationId: string) {
    return db
      .select()
      .from(traces)
      .where(eq(traces.conversationId, conversationId))
      .orderBy(sql`ts asc`);
  },

  /**
   * The provider-reported prompt size of this conversation's most recent turn.
   *
   * Recorded by `pi.service` as a `context.usage` trace. Read back here because
   * it is the only honest measure of how full the window is: the pre-run
   * estimate sees the chat history but not the system prompt or the tool
   * schemas, which for a workspace with an MCP server are the larger half.
   *
   * Null for a conversation that has not completed a turn yet.
   */
  async lastContextTokens(conversationId: string): Promise<number | null> {
    const rows = await db
      .select({ fields: traces.fields })
      .from(traces)
      .where(and(eq(traces.conversationId, conversationId), eq(traces.step, "context.usage")))
      .orderBy(sql`ts desc`)
      .limit(1);

    const raw = rows[0]?.fields;
    if (!raw) return null;
    try {
      const used = (JSON.parse(raw) as { used?: unknown }).used;
      return typeof used === "number" && used > 0 ? used : null;
    } catch {
      return null;
    }
  },

  /** Delete a conversation and its children (FK cascade). */
  async remove(conversationId: string): Promise<void> {
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  },

};
