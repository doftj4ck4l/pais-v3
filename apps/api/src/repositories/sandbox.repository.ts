import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, sandboxes } from "../db/client";
import type { SandboxRow } from "../models/schema";

/**
 * One sandbox per user.
 *
 * The workspace path outlives every container, so `containerId` going null is
 * the normal cold state rather than a deletion.
 */
export const sandboxRepository = {
  async get(userId: string): Promise<SandboxRow | undefined> {
    const rows = await db.select().from(sandboxes).where(eq(sandboxes.userId, userId)).limit(1);
    return rows[0];
  },

  async upsert(input: {
    userId: string;
    containerId: string | null;
    workspacePath: string;
    image: string;
  }): Promise<void> {
    const now = Date.now();
    await db
      .insert(sandboxes)
      .values({ ...input, createdAt: now, lastUsedAt: now })
      .onConflictDoUpdate({
        target: sandboxes.userId,
        set: { containerId: input.containerId, image: input.image, lastUsedAt: now },
      });
  },

  /** The container is gone; the workspace stays exactly where it is. */
  async clearContainer(userId: string): Promise<void> {
    await db
      .update(sandboxes)
      .set({ containerId: null, lastUsedAt: Date.now() })
      .where(eq(sandboxes.userId, userId));
  },

  async touch(userId: string): Promise<void> {
    await db.update(sandboxes).set({ lastUsedAt: Date.now() }).where(eq(sandboxes.userId, userId));
  },

  /** Rows still holding a container that has gone unused for `olderThanMs`. */
  async listIdle(olderThanMs: number): Promise<SandboxRow[]> {
    return db
      .select()
      .from(sandboxes)
      .where(
        and(
          isNotNull(sandboxes.containerId),
          lt(sandboxes.lastUsedAt, Date.now() - olderThanMs),
        ),
      );
  },
};
