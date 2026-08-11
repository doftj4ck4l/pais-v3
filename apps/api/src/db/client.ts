import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
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
export const DB_PATH =
  // Overridable so tests can drive the real HTTP surface against a throwaway
  // file instead of the working database.
  process.env.DB_PATH ?? path.resolve(process.cwd(), "data", "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/**
 * Generated migrations, resolved from this file rather than from `cwd`.
 *
 * Tests run from the repository root and the deployed API runs from
 * `/app/apps/api`; a relative folder would find them from one and not the
 * other, and a missing folder is not an error `migrate()` reports loudly.
 */
const MIGRATIONS_DIR = path.resolve(import.meta.dir, "..", "..", "drizzle");

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
 * Bring any database handle up to the current schema.
 *
 * Taking the handle as a parameter is what lets tests build a real in-memory
 * database with the exact production schema — including the FTS5 tables, whose
 * behaviour cannot be meaningfully faked.
 *
 * This used to be several hundred lines of hand-written DDL kept in step with
 * `models/schema.ts` by hand. It is now the generated migrations in `drizzle/`,
 * which are produced *from* that file, so the two cannot disagree.
 */
export function applySchema(target: Database) {
  migrate(drizzle(target), { migrationsFolder: MIGRATIONS_DIR });
  adoptLegacyColumns(target);
}

/**
 * Columns that databases predating migrations may be missing.
 *
 * Frozen. Nothing new belongs here — a column added from now on is a generated
 * migration, and 0000 already declares every column below.
 *
 * It survives because the baseline is guarded with IF NOT EXISTS, which is what
 * lets an existing database adopt it: a table that already exists is left
 * exactly as it was, including whatever columns it was missing. SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so each one is checked first.
 *
 * Getting this wrong is quiet: Drizzle selects a column SQLite does not have,
 * and SQLite answers with the column *name* rather than an error.
 */
function adoptLegacyColumns(target: Database) {
  // Nullable throughout: a row's workspace is unknown until `backfill` places it.
  for (const table of SCOPED_TABLES) {
    if (!columnsOf(target, table).includes("workspace_id")) {
      target.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
    }
  }

  // `traces` predates runs and per-span timing. Existing rows keep run_id NULL
  // and duration_ms 0 — they are point events from before the timeline existed,
  // and the admin page skips runs it cannot lay out.
  const traceColumns = columnsOf(target, "traces");
  if (!traceColumns.includes("run_id")) {
    target.exec(`ALTER TABLE traces ADD COLUMN run_id TEXT`);
  }
  if (!traceColumns.includes("duration_ms")) {
    target.exec(`ALTER TABLE traces ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`);
  }

  const mcpColumns = columnsOf(target, "mcp_servers");
  if (!mcpColumns.includes("error_detail")) {
    target.exec(`ALTER TABLE mcp_servers ADD COLUMN error_detail TEXT`);
  }

  const documentColumns = columnsOf(target, "documents");
  for (const column of ["connector_id", "external_id", "external_version", "external_url"]) {
    if (!documentColumns.includes(column)) {
      target.exec(`ALTER TABLE documents ADD COLUMN ${column} TEXT`);
    }
  }

  const runColumns = columnsOf(target, "runs");
  for (const column of ["tool_calls", "tool_errors"]) {
    if (!runColumns.includes(column)) {
      target.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }
}

/**
 * Tables whose repositories have been re-scoped and no longer read `user_id`.
 *
 * A table joins this list in the same commit that stops its repository reading
 * the column, never earlier. `user_id` was `NOT NULL` on databases created
 * before workspaces, so a table that has stopped being written with one but
 * still has the column would reject every new row.
 */
export const RESCOPED_TABLES = [
  "documents",
  "chunks",
  "db_connections",
  "db_tables",
  "db_columns",
  "memory_notes",
  "conversations",
];

/**
 * Migrate on boot, place any pre-workspace rows into a workspace, then retire
 * the old scoping key from the tables that have finished moving over.
 *
 * Migrations run here rather than from a CLI step so that starting the API is
 * the only thing anyone has to remember. To add a column: edit
 * `models/schema.ts`, run `bunx drizzle-kit generate`, commit the file it
 * writes. Nothing is hand-written any more.
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
