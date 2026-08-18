import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema: pure ORM definitions, no runtime connection.
 *
 * These describe the tables to the query builder; they do not create them.
 * `applySchema` in db/client.ts is what does, and it is the only thing that
 * does — so a column added here also needs an explicit `ALTER TABLE` there.
 */

// A single app user. Owns many workspaces.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(), // epoch ms
  /**
   * What this console calls you, when you would rather it did not use the name
   * the identity provider sends.
   *
   * Null means "use the proxy's". Nothing else about the identity is stored:
   * the provider remains the authority on who you are, and a copy of an email
   * or a group list here could only ever be a stale second opinion.
   */
  displayName: text("display_name"),
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

// ---- organizations: platform membership, never a workspace ownership key ----

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_organizations_created").on(t.createdAt)],
);

export type OrganizationRow = {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** Historical display snapshot. Authorization always uses userId. */
    email: text("email").notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_organization_memberships_org_user").on(t.organizationId, t.userId),
    index("idx_organization_memberships_user").on(t.userId, t.joinedAt),
  ],
);

export type OrganizationMembershipRow = {
  id: string;
  organizationId: string;
  userId: string;
  email: string;
  joinedAt: number;
};

export const organizationInvitations = sqliteTable(
  "organization_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenDigest: text("token_digest").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    acceptedByUserId: text("accepted_by_user_id").references(() => users.id),
    revokedAt: integer("revoked_at"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_organization_invitations_digest").on(t.tokenDigest),
    index("idx_organization_invitations_org").on(t.organizationId, t.createdAt),
    index("idx_organization_invitations_recipient").on(t.organizationId, t.email),
  ],
);

export type OrganizationInvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  tokenDigest: string;
  expiresAt: number;
  acceptedAt: number | null;
  acceptedByUserId: string | null;
  revokedAt: number | null;
  createdByUserId: string;
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
    /** Which run this span belongs to. Null for rows written before runs existed. */
    runId: text("run_id"),
    step: text("step").notNull(),
    fields: text("fields"), // JSON
    /**
     * When the span *ended*, in epoch ms, stamped as the event was recorded.
     *
     * Previously every row in a run shared one timestamp, because the whole
     * batch was stamped at flush time — which made a timeline impossible to
     * draw. Start is `ts - durationMs`.
     */
    ts: integer("ts").notNull(),
    /** Span length. 0 for instantaneous events like run.start. */
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (t) => [
    index("idx_traces_conversation").on(t.conversationId, t.ts),
    index("idx_traces_run").on(t.runId, t.ts),
  ],
);
export type TraceRow = {
  id: string;
  conversationId: string;
  runId: string | null;
  step: string;
  fields: string | null;
  ts: number;
  durationMs: number;
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

// ---- playbook: what the workspace has learned about doing its own work ----
//
// A curated layer above `memory_notes`, not a replacement for it. Notes are
// whatever the model chose to write down mid-run; bullets are distilled after
// the run from what actually happened, and every one of them is injected into
// the next system prompt.
//
// The counters are the reason this is a table rather than a text blob. A bullet
// that keeps preceding failures has to be demotable, and a demotion has to
// survive the run that noticed it — an LLM asked to rewrite the whole document
// instead loses the detail that made the bullet worth keeping (measured
// upstream as "context collapse": 18k tokens of playbook rewritten down to 122,
// taking accuracy below the no-playbook baseline).
export const playbookBullets = sqliteTable(
  "playbook_bullets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** fact | route | pitfall — see services/playbook/types.ts. */
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    /**
     * Normalised content, unique per workspace.
     *
     * The dedup backstop. The reflector is shown the existing bullets and asked
     * to update them by id rather than restate them, which handles the ordinary
     * case; this catches the time it ignores that and proposes bullet #7 as a
     * seventh phrasing of bullet #2.
     */
    fingerprint: text("fingerprint").notNull(),
    helpful: integer("helpful").notNull().default(0),
    harmful: integer("harmful").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** The run that first proposed it. Without this a bad bullet is unattributable. */
    runId: text("run_id"),
  },
  (t) => [
    index("idx_playbook_workspace").on(t.workspaceId, t.updatedAt),
    uniqueIndex("idx_playbook_fingerprint").on(t.workspaceId, t.fingerprint),
  ],
);

export type PlaybookBulletRow = {
  id: string;
  workspaceId: string;
  kind: string;
  content: string;
  fingerprint: string;
  helpful: number;
  harmful: number;
  createdAt: number;
  updatedAt: number;
  runId: string | null;
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
    /**
     * Where this document came from: null for an upload, otherwise the id of
     * the connector that synced it. A connector's documents are deleted with it.
     */
    connectorId: text("connector_id"),
    /** The source's own id for this file, unique within a connector. */
    externalId: text("external_id"),
    /**
     * The source's version marker — Drive's `version`, an etag elsewhere.
     * Compared on re-sync so an unchanged file is skipped rather than
     * re-extracted and re-chunked, which is the whole cost of a sync.
     */
    externalVersion: text("external_version"),
    /** Deep link back to the file in its source, for citations. */
    externalUrl: text("external_url"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_documents_workspace").on(t.workspaceId, t.createdAt),
    // Re-sync looks a document up by (connector, external id) on every file it
    // sees, so this index is on the hot path of the sync, not of search.
    index("idx_documents_external").on(t.connectorId, t.externalId),
  ],
);
export type DocumentSourceRow = {
  connectorId: string | null;
  externalId: string | null;
  externalVersion: string | null;
  externalUrl: string | null;
};

export type DocumentRow = {
  id: string;
  workspaceId: string | null;
  title: string;
  bytes: number;
  pages: number;
  chunkCount: number;
  status: DocumentStatus;
  error: string | null;
  connectorId: string | null;
  externalId: string | null;
  externalVersion: string | null;
  externalUrl: string | null;
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
 * One database a user has connected. `secret` holds the encrypted password and
 * private TLS options and is never selected into anything that reaches the
 * client or model. The non-secret connection fields remain individually
 * addressable so the API can support safe edits without reconstructing a URL.
 */
export const dbConnections = sqliteTable(
  "db_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    name: text("name").notNull(), // how the agent refers to it
    engine: text("engine").notNull().default("postgresql"),
    secret: text("secret").notNull(),
    host: text("display_host").notNull(),
    port: integer("port").notNull().default(5432),
    database: text("display_database").notNull(),
    username: text("username").notNull().default(""),
    sslMode: text("ssl_mode").notNull().default("disable"),
    // Keep the numeric SQLite default represented the same way as migration
    // metadata. `false` is stored as 0; spelling it as 0 here prevents
    // drizzle-kit from rebuilding this unrelated table on every generation.
    hasCustomCa: integer("has_custom_ca", { mode: "boolean" }).notNull().default(sql`0`),
    status: text("status").$type<DbConnectionStatus>().notNull().default("connected"),
    error: text("error"),
    tableCount: integer("table_count").notNull().default(0),
    lastIntrospectedAt: integer("last_introspected_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_db_connections_workspace").on(t.workspaceId, t.createdAt),
    // Same reasoning as mcp_servers: the agent asks for "the sales database" by
    // name, so the name has to be unique within the workspace and free to
    // repeat across workspaces.
    uniqueIndex("idx_db_connections_workspace_name").on(t.workspaceId, t.name),
  ],
);
export type DbConnectionRow = {
  id: string;
  workspaceId: string | null;
  name: string;
  engine: "postgresql";
  status: DbConnectionStatus;
  error: string | null;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "require" | "verify-full";
  hasCustomCa: boolean;
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

export type RunStatus = "running" | "done" | "error" | "stopped";

/**
 * One agent run: a single prompt turned into an answer.
 *
 * A conversation holds many runs, and until now nothing recorded where one
 * ended and the next began — traces were flushed against the conversation with
 * a single timestamp, so a run's shape could not be reconstructed at all. This
 * is the row the admin timeline lists and every span hangs from.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    harnessId: text("harness_id").notNull(),
    modelId: text("model_id").notNull(),
    /** The prompt this run answered, truncated. Enough to recognise it in a list. */
    prompt: text("prompt"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    turns: integer("turns").notNull().default(0),
    /** Provider-reported prompt and completion tokens, summed over the run's turns. */
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /** Tool calls made, and how many of them reported an error. */
    toolCalls: integer("tool_calls").notNull().default(0),
    toolErrors: integer("tool_errors").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    index("idx_runs_workspace").on(t.workspaceId, t.startedAt),
    index("idx_runs_conversation").on(t.conversationId, t.startedAt),
  ],
);
export type RunRow = {
  id: string;
  conversationId: string;
  workspaceId: string | null;
  harnessId: string;
  modelId: string;
  prompt: string | null;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  toolErrors: number;
  error: string | null;
};

export type McpTransport = "http" | "stdio";
export type McpServerStatus = "connected" | "error";

/**
 * One MCP server a user has connected.
 *
 * `headersEnc` (HTTP) and `envEnc` (stdio) hold encrypted JSON objects. They are
 * credentials — an API token in a header, a key in an env var — and are treated
 * exactly like `dbConnections.secret`: written by the repository, never selected
 * into anything that reaches the client or the model.
 *
 * The transport-specific columns are nullable rather than split into two tables.
 * A server is one row whichever way it is reached, and every consumer switches
 * on `transport` anyway.
 */
export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    name: text("name").notNull(), // how the agent refers to it: <name>__<tool>
    transport: text("transport").$type<McpTransport>().notNull(),
    url: text("url"), // http only
    headersEnc: text("headers_enc"), // http only
    command: text("command"), // stdio only
    argsJson: text("args_json"), // stdio only, JSON array
    envEnc: text("env_enc"), // stdio only
    enabled: integer("enabled").notNull().default(1), // 0 | 1
    status: text("status").$type<McpServerStatus>().notNull().default("connected"),
    error: text("error"),
    /**
     * Whatever the server said on the way down — a stdio launcher's stderr, or
     * an HTTP body. Separate from `error` because that one is a single line
     * shown in a row, and this is a traceback shown behind a click.
     */
    errorDetail: text("error_detail"),
    toolCount: integer("tool_count").notNull().default(0),
    lastProbedAt: integer("last_probed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_mcp_servers_workspace").on(t.workspaceId, t.createdAt),
    // The agent addresses a server by name, so two servers called "github" in
    // one workspace would make a tool name ambiguous. Two workspaces may each
    // have a "github" — that is the point of the composite key.
    uniqueIndex("idx_mcp_servers_workspace_name").on(t.workspaceId, t.name),
  ],
);
export type McpServerRow = {
  id: string;
  workspaceId: string | null;
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  argsJson: string | null;
  enabled: number;
  status: McpServerStatus;
  error: string | null;
  errorDetail: string | null;
  toolCount: number;
  lastProbedAt: number | null;
  createdAt: number;
};

export type McpCapabilityKind = "tool" | "resource" | "prompt";

/**
 * What one server advertised the last time it was probed.
 *
 * Cached rather than fetched on demand because both readers need it without a
 * live connection: the settings UI lists what a server offers, and the system
 * prompt names every tool the agent can call. Opening a socket to every server
 * to render a page — or to build a prompt — would make both fail whenever any
 * one server is down.
 */
export const mcpCapabilities = sqliteTable(
  "mcp_capabilities",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    kind: text("kind").$type<McpCapabilityKind>().notNull(),
    name: text("name").notNull(),
    // MCP's human-readable tool title, used by approval prompts. Unlike the
    // tool name it is meant to be shown directly to a person.
    title: text("title"),
    description: text("description"),
    // Tool `inputSchema` or prompt `arguments`, stored whole. Nothing searches
    // or joins it — it is read back verbatim and handed to the schema converter.
    schemaJson: text("schema_json"),
    // ToolAnnotations are advisory protocol metadata. Kept whole so expanding
    // the permission policy does not require another column per hint.
    annotationsJson: text("annotations_json"),
    uri: text("uri"), // resources only
  },
  (t) => [index("idx_mcp_capabilities_server").on(t.serverId, t.kind, t.name)],
);
export type McpCapabilityRow = {
  id: string;
  serverId: string;
  workspaceId: string | null;
  kind: McpCapabilityKind;
  name: string;
  title: string | null;
  description: string | null;
  schemaJson: string | null;
  annotationsJson: string | null;
  uri: string | null;
};

// ---- connectors: remote sources that sync into `documents` ----

export type ConnectorKind = "gdrive" | "gcal";
export type ConnectorStatus = "connected" | "syncing" | "error";

/**
 * One authorised remote source for one workspace.
 *
 * Authentication is per-user OAuth rather than an admin credential, and that is
 * the load-bearing decision: the source's API only ever returns what the person
 * who authorised it can already see, so permissions need no modelling here. The
 * alternative — crawling everything with a domain-wide credential and mirroring
 * each source's ACLs onto every row — is most of what makes an enterprise
 * search connector expensive, and a workspace has exactly one owner.
 *
 * It follows that a workspace shared with a second person would expose the
 * owner's indexed files to them. That is a real constraint on ever making
 * workspaces multi-user, not an oversight.
 */
export const connectors = sqliteTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    kind: text("kind").$type<ConnectorKind>().notNull(),
    /** Which account this is connected as. Display only; never used for auth. */
    accountEmail: text("account_email"),
    status: text("status").$type<ConnectorStatus>().notNull().default("connected"),
    error: text("error"),
    /**
     * OAuth tokens as an encrypted JSON blob, exactly like `dbConnections.secret`
     * and the MCP server secrets: written by the repository, never selected into
     * anything that reaches the client or the model.
     */
    tokensEnc: text("tokens_enc").notNull(),
    /**
     * The source's own change cursor — Drive's `startPageToken`. Stored rather
     * than a timestamp because every source that offers a change feed offers a
     * token, and a timestamp cannot express "changes I have already seen".
     */
    cursor: text("cursor"),
    lastSyncAt: integer("last_sync_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_connectors_workspace").on(t.workspaceId, t.createdAt)],
);
export type ConnectorRow = {
  id: string;
  workspaceId: string | null;
  kind: ConnectorKind;
  accountEmail: string | null;
  status: ConnectorStatus;
  error: string | null;
  cursor: string | null;
  lastSyncAt: number | null;
  createdAt: number;
};

/**
 * One image produced by the `generate_image` tool.
 *
 * The row is metadata only — the bytes live in the media bucket under
 * `storageKey`. Keeping them out of SQLite is deliberate: a Gemini image is
 * 25–200KB, and a base64 copy of one in the transcript would exceed
 * `RESULT_CHAR_CAP` by itself and then be re-sent to the model on every
 * following turn.
 */
export const generatedImages = sqliteTable(
  "generated_images",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** Null when generated outside a conversation (tests, direct API use). */
    conversationId: text("conversation_id"),
    prompt: text("prompt").notNull(),
    /** The OpenRouter model slug that produced it, e.g. google/gemini-3.1-flash-image. */
    model: text("model").notNull(),
    /** Object key in the media bucket. Workspace-prefixed, so a listing is scoped. */
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    /**
     * Cost in micro-dollars (1e-6 USD), not a float. One image ran $0.0336 in
     * testing — small enough that float drift over a month of rows would be a
     * real error, and integers make the sum exact.
     */
    costMicros: integer("cost_micros"),
    /**
     * `generated`, `uploaded`, or `shared`.
     *
     * The table is named for what first filled it, and now also holds images
     * the user pasted into the chat and images the agent drew in its workspace
     * and handed over with `share_file`. They share everything that matters — a
     * bucket object, a workspace, and the `/api/images/<id>` URL `read_image`
     * resolves — and differ in whether `model` and `cost_micros` mean anything.
     * Without this column an upload is a generation whose model happened to be
     * blank, which is the kind of thing that becomes a wrong cost report.
     */
    source: text("source").notNull().default("generated"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_generated_images_workspace").on(t.workspaceId, t.createdAt)],
);
export type GeneratedImageRow = {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  prompt: string;
  model: string;
  storageKey: string;
  contentType: string;
  bytes: number;
  costMicros: number | null;
  source: string;
  createdAt: number;
};
