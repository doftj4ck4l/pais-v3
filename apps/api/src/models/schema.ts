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

// One sandbox per user: a workspace that persists, and a container that does not.
export const sandboxes = sqliteTable(
  "sandboxes",
  {
    userId: text("user_id").primaryKey(),
    // Null when the container has been reaped. Normal, not an error state.
    containerId: text("container_id"),
    workspacePath: text("workspace_path").notNull(),
    image: text("image").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (t) => [index("idx_sandboxes_last_used").on(t.lastUsedAt)],
);

export type SandboxRow = {
  userId: string;
  containerId: string | null;
  workspacePath: string;
  image: string;
  createdAt: number;
  lastUsedAt: number;
};

// ---- context layer: uploaded documents and their retrievable chunks ----

/**
 * How ingestion ended. `indexed` is the only state the search tool will read
 * from; `empty` means the file parsed but yielded no text layer (a scanned PDF),
 * which is reported to the user rather than left looking like a success.
 */
export type DocumentStatus = "indexed" | "empty" | "error";

// One uploaded file per row, scoped to a user like conversations and memory.
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(), // original filename
    bytes: integer("bytes").notNull(),
    pages: integer("pages").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    status: text("status").$type<DocumentStatus>().notNull().default("indexed"),
    error: text("error"), // why status is `empty` or `error`, for the UI
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_documents_user").on(t.userId, t.createdAt)],
);
export type DocumentRow = {
  id: string;
  userId: string;
  title: string;
  bytes: number;
  pages: number;
  chunkCount: number;
  status: DocumentStatus;
  error: string | null;
  createdAt: number;
};

/**
 * A retrievable passage. This is the source of truth for chunk text and its
 * provenance; `chunks_fts` (created in ensureSchema, since Drizzle has no
 * virtual-table support) mirrors the text for ranking and is kept in sync by
 * the repository.
 */
export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // denormalised so search filters without a join
    seq: integer("seq").notNull(), // order within the document
    page: integer("page").notNull(), // 1-based, for citations
    text: text("text").notNull(),
  },
  (t) => [index("idx_chunks_document").on(t.documentId, t.seq)],
);
export type ChunkRow = {
  id: string;
  documentId: string;
  userId: string;
  seq: number;
  page: number;
  text: string;
};
