import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import path from "node:path";
import fs from "node:fs";
import { memoryNotes, users, conversations, messages, traces } from "../models/schema";

/** Where the SQLite database file lives (ignored by git). */
export const DB_PATH = path.resolve(process.cwd(), "data", "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export { memoryNotes, users, conversations, messages, traces };
export type {
  MemoryNoteRow,
  ConversationRow,
  MessageRow,
  TraceRow,
} from "../models/schema";

const sqlite = new Database(DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite);

/** Auto-create tables on boot (dev-friendly; drizzle-kit for real migrations). */
export function ensureSchema() {
  sqlite.exec(`
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
  `);
}
