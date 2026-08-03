import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import path from "node:path";
import fs from "node:fs";
import {
  memoryNotes,
  users,
  conversations,
  messages,
  traces,
  sandboxes,
  documents,
  chunks,
} from "../models/schema";

/** Where the SQLite database file lives (ignored by git). */
export const DB_PATH = path.resolve(process.cwd(), "data", "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export { memoryNotes, users, conversations, messages, traces, sandboxes, documents, chunks };
export type {
  SandboxRow,
  MemoryNoteRow,
  ConversationRow,
  MessageRow,
  TraceRow,
  DocumentRow,
  DocumentStatus,
  ChunkRow,
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
 */
export function applySchema(target: Database) {
  target.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      harness_id  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, created_at);
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
    CREATE TABLE IF NOT EXISTS memory_notes (
      id       TEXT PRIMARY KEY,
      user_id  TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      content  TEXT NOT NULL,
      tags     TEXT,
      source   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_user_ts ON memory_notes (user_id, ts);
    CREATE TABLE IF NOT EXISTS sandboxes (
      user_id        TEXT PRIMARY KEY,
      container_id   TEXT,
      workspace_path TEXT NOT NULL,
      image          TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      last_used_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sandboxes_last_used ON sandboxes (last_used_at);
    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      pages       INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'indexed',
      error       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id, created_at);
    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      page        INTEGER NOT NULL,
      text        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id, seq);
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
}

/** Auto-create tables on boot (dev-friendly; drizzle-kit for real migrations). */
export function ensureSchema() {
  applySchema(sqlite);
}
