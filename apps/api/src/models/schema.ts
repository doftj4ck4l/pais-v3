import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema (pure ORM definitions — no runtime connection), so both the
 * Bun runtime and drizzle-kit (Node) can load it.
 */

// A single app user. Owns many conversations.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(), // epoch ms
});

/**
 * How a run ended. `running` is the state while it is in flight; a row left at
 * `running` means the server died mid-run.
 */
export type ConversationStatus = "running" | "done" | "stopped" | "error";

// One conversation per user. Each conversation holds the agent run + traces
// (1 user -> many conversations -> many messages/traces).
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(), // the agent's task / first prompt
    modelId: text("model_id").notNull(),
    harnessId: text("harness_id").notNull(),
    status: text("status").$type<ConversationStatus>().notNull().default("running"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_conversations_user").on(t.userId, t.createdAt)],
);
export type ConversationRow = {
  id: string;
  userId: string;
  title: string;
  modelId: string;
  harnessId: string;
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
};

// Transcript items for a conversation (user prompt, assistant text, thinking,
// iteration, tool call, tool result). Ordered by seq.
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // user | assistant | thinking | iteration | tool
    seq: integer("seq").notNull(),
    text: text("text"), // payload (JSON for tool: name/args/result)
    ts: integer("ts").notNull(),
  },
  (t) => [index("idx_messages_conversation").on(t.conversationId, t.seq)],
);
export type MessageRow = {
  id: string;
  conversationId: string;
  kind: string;
  seq: number;
  text: string | null;
  ts: number;
};

// Raw trace lines for a conversation (step + fields), in order.
export const traces = sqliteTable(
  "traces",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    fields: text("fields"), // JSON
    ts: integer("ts").notNull(),
  },
  (t) => [index("idx_traces_conversation").on(t.conversationId, t.ts)],
);
export type TraceRow = {
  id: string;
  conversationId: string;
  step: string;
  fields: string | null;
  ts: number;
};

// ---- memory (existing) ----
export const memoryNotes = sqliteTable("memory_notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  ts: integer("ts").notNull(), // epoch ms
  content: text("content").notNull(),
  tags: text("tags"), // newline-separated, or NULL
  source: text("source"), // user / conversation / agent
});

export type MemoryNoteRow = {
  id: string;
  userId: string;
  ts: number;
  content: string;
  tags: string | null;
  source: string | null;
};
