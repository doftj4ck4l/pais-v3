import { and, eq, sql } from "drizzle-orm";
import { db, generatedImages } from "../db/client";
import type { GeneratedImageRow } from "../models/schema";

export type NewImage = {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  prompt: string;
  model: string;
  storageKey: string;
  contentType: string;
  bytes: number;
  costMicros: number | null;
  /** Defaults to `generated`, which is what every writer before uploads meant. */
  source?: "generated" | "uploaded";
};

export interface ImageStore {
  save(image: NewImage): Promise<void>;
  list(workspaceId: string, limit?: number): Promise<GeneratedImageRow[]>;
  /** By id alone — the serving route has no workspace in its path. */
  get(id: string): Promise<GeneratedImageRow | undefined>;
  remove(workspaceId: string, id: string): Promise<GeneratedImageRow | undefined>;
}

/** The only thing that touches `generated_images`. */
export class SqliteImageStore implements ImageStore {
  constructor(private readonly dbImpl: typeof db = db) {}

  async save(image: NewImage): Promise<void> {
    await this.dbImpl
      .insert(generatedImages)
      .values({ ...image, source: image.source ?? "generated", createdAt: Date.now() })
      .run();
  }

  async list(workspaceId: string, limit = 50): Promise<GeneratedImageRow[]> {
    const rows = await this.dbImpl
      .select()
      .from(generatedImages)
      .where(eq(generatedImages.workspaceId, workspaceId))
      .orderBy(sql`created_at desc`)
      .limit(limit);
    return rows as GeneratedImageRow[];
  }

  async get(id: string): Promise<GeneratedImageRow | undefined> {
    const rows = await this.dbImpl
      .select()
      .from(generatedImages)
      .where(eq(generatedImages.id, id))
      .limit(1);
    return rows[0] as GeneratedImageRow | undefined;
  }

  /**
   * Delete the row and hand it back, so the caller can drop the object too.
   * The row goes first: an orphaned object costs storage, an orphaned row is a
   * broken image in the transcript.
   */
  async remove(workspaceId: string, id: string): Promise<GeneratedImageRow | undefined> {
    const rows = await this.dbImpl
      .select()
      .from(generatedImages)
      .where(and(eq(generatedImages.workspaceId, workspaceId), eq(generatedImages.id, id)))
      .limit(1);
    const row = rows[0] as GeneratedImageRow | undefined;
    if (!row) return undefined;
    await this.dbImpl.delete(generatedImages).where(eq(generatedImages.id, id)).run();
    return row;
  }
}

export const imageStore: ImageStore = new SqliteImageStore();
