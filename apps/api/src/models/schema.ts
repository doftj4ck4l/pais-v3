import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema (pure ORM definitions — no runtime connection), so both the
 * Bun runtime and drizzle-kit (Node) can load it.
 */

// A single app user. Owns many workspaces.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(), // epoch ms
});

/**
 * A container for one body of work: its agents, documents, databases and files.
 *
 * This is the scoping key for everything below. `user_id` lives here and only
 * here — it is the ownership root, and every other table reaches a user by way
 * of its workspace rather than carrying its own copy.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_workspaces_user").on(t.userId, t.createdAt)],
);
export type WorkspaceRow = {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
};

/**
 * How a run ended. `running` is the state while it is in flight; a row left at
 * `running` means the server died mid-run.
 */
export type ConversationStatus = "running" | "done" | "stopped" | "error";

// One conversation per agent run, held by a workspace alongside its traces
// (1 workspace -> many conversations -> many messages/traces).
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    title: text("title").notNull(), // the agent's task / first prompt
    modelId: text("model_id").notNull(),
    harnessId: text("harness_id").notNull(),
    status: text("status").$type<ConversationStatus>().notNull().default("running"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_conversations_workspace").on(t.workspaceId, t.createdAt)],
);
export type ConversationRow = {
  id: string;
  workspaceId: string | null;
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

// ---- memory: notes the agent keeps for one workspace between runs ----
export const memoryNotes = sqliteTable(
  "memory_notes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    ts: integer("ts").notNull(), // epoch ms
    content: text("content").notNull(),
    tags: text("tags"), // newline-separated, or NULL
    source: text("source"), // user / conversation / agent
  },
  (t) => [index("idx_memory_workspace_ts").on(t.workspaceId, t.ts)],
);

export type MemoryNoteRow = {
  id: string;
  workspaceId: string | null;
  ts: number;
  content: string;
  tags: string | null;
  source: string | null;
};

// One sandbox per workspace: a directory that persists, and a container that
// does not. The directory is the workspace's file storage, which is why the two
// meanings of the word collapse into one here.
export const sandboxes = sqliteTable(
  "sandboxes",
  {
    workspaceId: text("workspace_id").primaryKey(),
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
  workspaceId: string;
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

// One uploaded file per row, scoped to a workspace like conversations and memory.
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    title: text("title").notNull(), // original filename
    bytes: integer("bytes").notNull(),
    pages: integer("pages").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    status: text("status").$type<DocumentStatus>().notNull().default("indexed"),
    error: text("error"), // why status is `empty` or `error`, for the UI
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_documents_workspace").on(t.workspaceId, t.createdAt)],
);
export type DocumentRow = {
  id: string;
  workspaceId: string | null;
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
    // denormalised so search filters without a join
    workspaceId: text("workspace_id"),
    seq: integer("seq").notNull(), // order within the document
    page: integer("page").notNull(), // 1-based, for citations
    text: text("text").notNull(),
  },
  (t) => [
    index("idx_chunks_document").on(t.documentId, t.seq),
    index("idx_chunks_workspace").on(t.workspaceId),
  ],
);
export type ChunkRow = {
  id: string;
  documentId: string;
  workspaceId: string | null;
  seq: number;
  page: number;
  text: string;
};

// ---- context layer: connected databases and their schema snapshot ----

/** Whether the last introspection of a connection succeeded. */
export type DbConnectionStatus = "connected" | "error";

/**
 * One database a user has connected. `secret` holds the encrypted connection
 * string and is never selected into anything that reaches the client or the
 * model — `displayHost` / `displayDatabase` exist so the UI can identify a
 * connection without it.
 */
export const dbConnections = sqliteTable(
  "db_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    name: text("name").notNull(), // how the agent refers to it
    engine: text("engine").notNull().default("postgres"),
    secret: text("secret").notNull(),
    displayHost: text("display_host").notNull(),
    displayDatabase: text("display_database").notNull(),
    status: text("status").$type<DbConnectionStatus>().notNull().default("connected"),
    error: text("error"),
    tableCount: integer("table_count").notNull().default(0),
    lastIntrospectedAt: integer("last_introspected_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_db_connections_workspace").on(t.workspaceId, t.createdAt)],
);
export type DbConnectionRow = {
  id: string;
  workspaceId: string | null;
  name: string;
  engine: string;
  status: DbConnectionStatus;
  error: string | null;
  displayHost: string;
  displayDatabase: string;
  tableCount: number;
  lastIntrospectedAt: number | null;
  createdAt: number;
};

/** One table (or view) in a connection's snapshot. */
export const dbTables = sqliteTable(
  "db_tables",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => dbConnections.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    schemaName: text("schema_name").notNull(),
    name: text("name").notNull(),
    comment: text("comment"),
    rowEstimate: integer("row_estimate").notNull().default(0),
    columnCount: integer("column_count").notNull().default(0),
    // JSON array of index definitions. Stored whole rather than in its own table
    // because nothing searches or joins them — they are read back as a hint that
    // a filter is cheap.
    indexes: text("indexes"),
  },
  (t) => [index("idx_db_tables_connection").on(t.connectionId, t.schemaName, t.name)],
);
export type DbTableRow = {
  id: string;
  connectionId: string;
  workspaceId: string | null;
  schemaName: string;
  name: string;
  comment: string | null;
  rowEstimate: number;
  columnCount: number;
  indexes: string | null;
};

/** One column, with the foreign key that makes a correct join possible. */
export const dbColumns = sqliteTable(
  "db_columns",
  {
    id: text("id").primaryKey(),
    tableId: text("table_id")
      .notNull()
      .references(() => dbTables.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    workspaceId: text("workspace_id"),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    dataType: text("data_type").notNull(),
    nullable: integer("nullable").notNull(), // 0 | 1
    isPrimaryKey: integer("is_primary_key").notNull(), // 0 | 1
    fkTable: text("fk_table"), // "schema.table"
    fkColumn: text("fk_column"),
    comment: text("comment"),
  },
  (t) => [index("idx_db_columns_table").on(t.tableId, t.seq)],
);
export type DbColumnRow = {
  id: string;
  tableId: string;
  connectionId: string;
  workspaceId: string | null;
  seq: number;
  name: string;
  dataType: string;
  nullable: number;
  isPrimaryKey: number;
  fkTable: string | null;
  fkColumn: string | null;
  comment: string | null;
};
