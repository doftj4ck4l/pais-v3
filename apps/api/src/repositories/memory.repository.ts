import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { memoryNotes } from "../models/schema";
import type { MemoryNoteRow } from "../models/schema";

/**
 * Agent memory: a per-user, append-only log of notes the agent persists between
 * sessions.
 *
 * Behind the MemoryStore interface so the implementation can be swapped
 * (Postgres, S3, ...) without touching the tools that call it.
 */
export interface MemoryStore {
  append(userId: string, entry: MemoryEntry): Promise<void>;
  search(userId: string, query: string): Promise<MemoryEntry[]>;
  all(userId: string): Promise<MemoryEntry[]>;
}

export interface MemoryEntry {
  id: string;
  ts: number; // epoch ms
  content: string;
  tags?: string[];
  source?: string;
}

function rowToEntry(row: MemoryNoteRow): MemoryEntry {
  return {
    id: row.id,
    ts: row.ts,
    content: row.content,
    tags: row.tags ? row.tags.split("\n").filter(Boolean) : undefined,
    source: row.source ?? undefined,
  };
}

/**
 * SQLite-backed MemoryStore. Search is a case-insensitive substring match on
 * content and tags — enough for agent recall. Returns newest-first.
 */
export class SqliteMemoryStore implements MemoryStore {
  constructor(private dbImpl: typeof db = db) {}

  async append(userId: string, entry: MemoryEntry): Promise<void> {
    await this.dbImpl
      .insert(memoryNotes)
      .values({
        id: entry.id,
        userId,
        ts: entry.ts,
        content: entry.content,
        tags: entry.tags?.join("\n") || null,
        source: entry.source ?? null,
      })
      .onConflictDoNothing();
  }

  async search(userId: string, query: string): Promise<MemoryEntry[]> {
    const q = query.trim().toLowerCase();
    const rows = q
      ? await this.dbImpl
          .select()
          .from(memoryNotes)
          .where(
            and(
              eq(memoryNotes.userId, userId),
              sql`(lower(${memoryNotes.content}) like ${`%${q}%`} or coalesce(lower(${memoryNotes.tags}),'') like ${`%${q}%`})`,
            ),
          )
          .orderBy(sql`ts desc`)
      : await this.dbImpl
          .select()
          .from(memoryNotes)
          .where(eq(memoryNotes.userId, userId))
          .orderBy(sql`ts desc`);
    return rows.map(rowToEntry);
  }

  async all(userId: string): Promise<MemoryEntry[]> {
    const rows = await this.dbImpl
      .select()
      .from(memoryNotes)
      .where(eq(memoryNotes.userId, userId))
      .orderBy(sql`ts desc`);
    return rows.map(rowToEntry);
  }
}

/** Default app-wide store. */
export const memoryStore: MemoryStore = new SqliteMemoryStore();
