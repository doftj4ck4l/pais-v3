import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import path from "node:path";
import fs from "node:fs";
import {
  backfill,
  columnsOf,
  dropLegacyUserId,
  migrateSandboxDirs,
  rebuildSandboxes,
  SCOPED_TABLES,
} from "./backfill";
import {
  memoryNotes,
  users,
  workspaces,
  conversations,
  messages,
  traces,
  sandboxes,
  documents,
  chunks,
  dbConnections,
  dbTables,
  dbColumns,
  mcpServers,
  mcpCapabilities,
  runs,
  connectors,
  generatedImages,
} from "../models/schema";

/** Where the SQLite database file lives (ignored by git). */
export const DB_PATH = path.resolve(process.cwd(), "data", "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export {
  memoryNotes,
  users,
  workspaces,
  conversations,
  messages,
  traces,
  sandboxes,
  documents,
  chunks,
  dbConnections,
  dbTables,
  dbColumns,
  mcpServers,
  mcpCapabilities,
  runs,
  connectors,
  generatedImages,
};
export type {
  WorkspaceRow,
  SandboxRow,
  MemoryNoteRow,
  ConversationRow,
  MessageRow,
  TraceRow,
  DocumentRow,
  DocumentStatus,
  ChunkRow,
  DbConnectionRow,
  DbConnectionStatus,
  DbTableRow,
  DbColumnRow,
  McpServerRow,
  McpServerStatus,
  McpTransport,
  McpCapabilityRow,
  McpCapabilityKind,
  RunRow,
  RunStatus,
  ConnectorRow,
  ConnectorKind,
  ConnectorStatus,
} from "../models/schema";

const sqlite = new Database(DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite);

/**
 * Apply the full schema to any database handle. Taking the handle as a
 * parameter is what lets tests build a real in-memory database with the exact
 * production schema — including the FTS5 table, whose behaviour cannot be
 * meaningfully faked.
 *
 * The scoped tables below still declare a nullable `user_id`. Nothing reads or
 * writes it — the Drizzle models have dropped it, and `ensureSchema` drops the
 * column outright once a table's rows are placed. It survives here only so that
 * `backfill` has somewhere to read an old row's owner from, and so a database
 * written before workspaces existed still matches this DDL on the one boot
 * where that matters. Scope by `workspace_id`.
 */
export function applySchema(target: Database) {
  target.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces (user_id, created_at);
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      harness_id  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      text            TEXT,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, seq);
    CREATE TABLE IF NOT EXISTS traces (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      step            TEXT NOT NULL,
      fields          TEXT,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_traces_conversation ON traces (conversation_id, ts);
    CREATE TABLE IF NOT EXISTS runs (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      workspace_id    TEXT,
      harness_id      TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      prompt          TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      status          TEXT NOT NULL DEFAULT 'running',
      turns           INTEGER NOT NULL DEFAULT 0,
      tokens_in       INTEGER NOT NULL DEFAULT 0,
      tokens_out      INTEGER NOT NULL DEFAULT 0,
      tool_calls      INTEGER NOT NULL DEFAULT 0,
      tool_errors     INTEGER NOT NULL DEFAULT 0,
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_workspace    ON runs (workspace_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs (conversation_id, started_at);
    CREATE TABLE IF NOT EXISTS memory_notes (
      id       TEXT PRIMARY KEY,
      user_id  TEXT,
      ts       INTEGER NOT NULL,
      content  TEXT NOT NULL,
      tags     TEXT,
      source   TEXT
    );
    CREATE TABLE IF NOT EXISTS sandboxes (
      workspace_id   TEXT PRIMARY KEY,
      container_id   TEXT,
      workspace_path TEXT NOT NULL,
      image          TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      last_used_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sandboxes_last_used ON sandboxes (last_used_at);
    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      user_id     TEXT,
      title       TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      pages       INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'indexed',
      error       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id     TEXT,
      seq         INTEGER NOT NULL,
      page        INTEGER NOT NULL,
      text        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id, seq);
    CREATE TABLE IF NOT EXISTS db_connections (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT,
      name                 TEXT NOT NULL,
      engine               TEXT NOT NULL DEFAULT 'postgres',
      secret               TEXT NOT NULL,
      display_host         TEXT NOT NULL,
      display_database     TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'connected',
      error                TEXT,
      table_count          INTEGER NOT NULL DEFAULT 0,
      last_introspected_at INTEGER,
      created_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS db_tables (
      id            TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
      user_id       TEXT,
      schema_name   TEXT NOT NULL,
      name          TEXT NOT NULL,
      comment       TEXT,
      row_estimate  INTEGER NOT NULL DEFAULT 0,
      column_count  INTEGER NOT NULL DEFAULT 0,
      indexes       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_db_tables_connection ON db_tables (connection_id, schema_name, name);
    CREATE TABLE IF NOT EXISTS db_columns (
      id             TEXT PRIMARY KEY,
      table_id       TEXT NOT NULL REFERENCES db_tables(id) ON DELETE CASCADE,
      connection_id  TEXT NOT NULL,
      user_id        TEXT,
      seq            INTEGER NOT NULL,
      name           TEXT NOT NULL,
      data_type      TEXT NOT NULL,
      nullable       INTEGER NOT NULL,
      is_primary_key INTEGER NOT NULL,
      fk_table       TEXT,
      fk_column      TEXT,
      comment        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_db_columns_table ON db_columns (table_id, seq);
    -- MCP tables are declared with workspace_id inline: they were born after
    -- workspaces existed, so they never carried a user_id and are not in
    -- SCOPED_TABLES. Their indexes can therefore be created here rather than
    -- after the ALTER pass below.
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT,
      name           TEXT NOT NULL,
      transport      TEXT NOT NULL,
      url            TEXT,
      headers_enc    TEXT,
      command        TEXT,
      args_json      TEXT,
      env_enc        TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      status         TEXT NOT NULL DEFAULT 'connected',
      error          TEXT,
      tool_count     INTEGER NOT NULL DEFAULT 0,
      last_probed_at INTEGER,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_workspace ON mcp_servers (workspace_id, created_at);
    -- Same reasoning as db_connections: the agent addresses a server by name,
    -- so two servers called "github" in one workspace would make github__search
    -- ambiguous. Two separate workspaces may each have one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_workspace_name
      ON mcp_servers (workspace_id, name);
    CREATE TABLE IF NOT EXISTS mcp_capabilities (
      id           TEXT PRIMARY KEY,
      server_id    TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      workspace_id TEXT,
      kind         TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      schema_json  TEXT,
      uri          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_capabilities_server
      ON mcp_capabilities (server_id, kind, name);
    CREATE INDEX IF NOT EXISTS idx_mcp_capabilities_workspace
      ON mcp_capabilities (workspace_id, kind);
  `);

  // Databases created before workspaces have none of the columns above, and
  // ALTER TABLE has no IF NOT EXISTS in SQLite — so each one is added only when
  // the table is missing it. Nullable throughout: a row's workspace is unknown
  // until `backfill` places it.
  for (const table of SCOPED_TABLES) {
    if (!columnsOf(target, table).includes("workspace_id")) {
      target.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
    }
  }

  // `traces` predates runs and per-span timing. SQLite has no ALTER TABLE ...
  // IF NOT EXISTS, so each column is added only when it is missing. Existing
  // rows keep run_id NULL and duration_ms 0 — they are point events from before
  // the timeline existed, and the admin page skips runs it cannot lay out.
  const traceColumns = columnsOf(target, "traces");
  if (!traceColumns.includes("run_id")) {
    target.exec(`ALTER TABLE traces ADD COLUMN run_id TEXT`);
  }
  if (!traceColumns.includes("duration_ms")) {
    target.exec(`ALTER TABLE traces ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`);
  }
  target.exec(`CREATE INDEX IF NOT EXISTS idx_traces_run ON traces (run_id, ts)`);

  // Connectors, and the columns that tie a document back to the file it came
  // from. `documents` predates all of this, and `CREATE TABLE IF NOT EXISTS`
  // does nothing for a table that already exists — without these ALTERs Drizzle
  // selects columns SQLite does not have, and the API returns the column *name*
  // as the value rather than erroring.
  target.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT,
      kind           TEXT NOT NULL,
      account_email  TEXT,
      status         TEXT NOT NULL DEFAULT 'connected',
      error          TEXT,
      tokens_enc     TEXT NOT NULL,
      cursor         TEXT,
      last_sync_at   INTEGER,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connectors_workspace ON connectors (workspace_id, created_at);
    CREATE TABLE IF NOT EXISTS generated_images (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      conversation_id TEXT,
      prompt          TEXT NOT NULL,
      model           TEXT NOT NULL,
      storage_key     TEXT NOT NULL,
      content_type    TEXT NOT NULL,
      bytes           INTEGER NOT NULL,
      cost_micros     INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generated_images_workspace
      ON generated_images (workspace_id, created_at);
  `);

  const documentColumns = columnsOf(target, "documents");
  for (const column of ["connector_id", "external_id", "external_version", "external_url"]) {
    if (!documentColumns.includes(column)) {
      target.exec(`ALTER TABLE documents ADD COLUMN ${column} TEXT`);
    }
  }
  target.exec(
    `CREATE INDEX IF NOT EXISTS idx_documents_external ON documents (connector_id, external_id)`,
  );

  // Same story for `runs`: the columns above only apply to a table being
  // created for the first time. A database that already has `runs` needs them
  // added, or every select against the Drizzle model asks for a column SQLite
  // does not have.
  const runColumns = columnsOf(target, "runs");
  for (const column of ["tool_calls", "tool_errors"]) {
    if (!runColumns.includes(column)) {
      target.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  target.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_documents_workspace     ON documents (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_workspace        ON chunks (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_db_connections_workspace ON db_connections (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_db_tables_workspace     ON db_tables (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_db_columns_workspace    ON db_columns (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_memory_workspace_ts     ON memory_notes (workspace_id, ts);
    CREATE INDEX IF NOT EXISTS idx_sandboxes_workspace     ON sandboxes (workspace_id);
    -- The agent addresses a connection by name, so a duplicate name inside one
    -- workspace would make "query the sales database" ambiguous. Two separate
    -- workspaces may each have a connection called prod — that is the point.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_db_connections_workspace_name
      ON db_connections (workspace_id, name);
  `);

  // FTS5 is a virtual table, which Drizzle cannot express — raw DDL only.
  // `porter` stems the index, so a query for "refund" also hits "refundable";
  // the default unicode61 tokenizer would miss it.
  target.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      chunk_id    UNINDEXED,
      document_id UNINDEXED,
      tokenize = 'porter'
    );
  `);

  // Schema search. Same `porter` reasoning as chunks_fts: a search for "refund"
  // should reach a table called `refunds`.
  target.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS db_schema_fts USING fts5(
      text,
      object_id     UNINDEXED,
      connection_id UNINDEXED,
      kind          UNINDEXED,
      tokenize = 'porter'
    );
  `);
}

/**
 * Tables whose repositories have been re-scoped and no longer read `user_id`.
 *
 * A table joins this list in the same commit that stops its repository reading
 * the column, never earlier. `user_id` was `NOT NULL` on databases created
 * before workspaces, so a table that has stopped being written with one but
 * still has the column would reject every new row.
 */
const RESCOPED_TABLES = [
  "documents",
  "chunks",
  "db_connections",
  "db_tables",
  "db_columns",
  "memory_notes",
  "conversations",
];

/**
 * Auto-create tables on boot (dev-friendly; drizzle-kit for real migrations),
 * place any pre-workspace rows into a workspace, then retire the old scoping
 * key from the tables that have finished moving over.
 *
 * Order matters: the sandbox directories are moved while `user_id` still says
 * who owned them, and only then is the column given up.
 */
export function ensureSchema() {
  applySchema(sqlite);
  backfill(sqlite);
  migrateSandboxDirs(sqlite);
  dropLegacyUserId(sqlite, RESCOPED_TABLES);
  rebuildSandboxes(sqlite);
}
