import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { playbookBullets } from "../models/schema";
import type { PlaybookBulletRow } from "../models/schema";
import { fingerprint } from "../services/playbook/delta";
import { BULLET_KINDS, type Bullet, type BulletDelta, type BulletKind } from "../services/playbook/types";

/**
 * The playbook store: per-workspace bullets, and the deterministic merge that
 * applies a run's deltas to them.
 *
 * The merge lives here, in code, rather than in the reflector's prompt. That is
 * the whole design: the model proposes, and a function with no judgment of its
 * own decides what that means for the stored document. Appending, incrementing
 * and deduplicating are not tasks a language model should be asked to do
 * reliably a hundred times in a row.
 */
export interface PlaybookStore {
  list(workspaceId: string): Promise<Bullet[]>;
  apply(workspaceId: string, runId: string | null, deltas: BulletDelta[]): Promise<ApplyResult>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export type ApplyResult = {
  added: number;
  revised: number;
  /** `add` ops that matched an existing bullet and became a confirmation instead. */
  confirmed: number;
  helpful: number;
  harmful: number;
};

const EMPTY_RESULT: ApplyResult = { added: 0, revised: 0, confirmed: 0, helpful: 0, harmful: 0 };

const genId = () => `pb_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

const asKind = (value: string): BulletKind =>
  (BULLET_KINDS as readonly string[]).includes(value) ? (value as BulletKind) : "fact";

function rowToBullet(row: PlaybookBulletRow): Bullet {
  return {
    id: row.id,
    kind: asKind(row.kind),
    content: row.content,
    helpful: row.helpful,
    harmful: row.harmful,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqlitePlaybookStore implements PlaybookStore {
  constructor(private dbImpl: typeof db = db) {}

  async list(workspaceId: string): Promise<Bullet[]> {
    const rows = await this.dbImpl
      .select()
      .from(playbookBullets)
      .where(eq(playbookBullets.workspaceId, workspaceId))
      .orderBy(sql`updated_at desc`);
    return rows.map(rowToBullet);
  }

  async apply(
    workspaceId: string,
    runId: string | null,
    deltas: BulletDelta[],
  ): Promise<ApplyResult> {
    if (!deltas.length) return { ...EMPTY_RESULT };

    const result = { ...EMPTY_RESULT };
    const now = Date.now();

    // Read once. Deltas within a run are few and the fingerprint index is
    // unique, so the only race worth handling is two runs of the same workspace
    // finishing together — which the insert's conflict clause absorbs.
    const existing = await this.list(workspaceId);
    const byFingerprint = new Map(existing.map((b) => [fingerprint(b.content), b.id]));

    for (const delta of deltas) {
      switch (delta.op) {
        case "add": {
          const print = fingerprint(delta.content);
          const duplicate = byFingerprint.get(print);
          if (duplicate) {
            // Not a no-op: the run re-derived something already known, which is
            // the clearest evidence the bullet is worth keeping. Counting it as
            // a confirmation is what lets a genuinely useful bullet outrank a
            // one-off, without anyone rating anything.
            await this.bump(workspaceId, duplicate, "helpful", now);
            result.confirmed++;
            break;
          }
          const id = genId();
          await this.dbImpl
            .insert(playbookBullets)
            .values({
              id,
              workspaceId,
              kind: delta.kind,
              content: delta.content,
              fingerprint: print,
              helpful: 0,
              harmful: 0,
              createdAt: now,
              updatedAt: now,
              runId,
            })
            .onConflictDoNothing();
          byFingerprint.set(print, id);
          result.added++;
          break;
        }
        case "revise": {
          const print = fingerprint(delta.content);
          const clash = byFingerprint.get(print);
          // Revising a bullet into an existing one would violate the unique
          // index and lose the revision silently. Dropped instead.
          if (clash && clash !== delta.id) break;
          await this.dbImpl
            .update(playbookBullets)
            .set({ content: delta.content, fingerprint: print, updatedAt: now })
            .where(and(eq(playbookBullets.workspaceId, workspaceId), eq(playbookBullets.id, delta.id)));
          byFingerprint.set(print, delta.id);
          result.revised++;
          break;
        }
        case "helpful":
        case "harmful": {
          await this.bump(workspaceId, delta.id, delta.op, now);
          result[delta.op]++;
          break;
        }
      }
    }

    return result;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.dbImpl
      .delete(playbookBullets)
      .where(and(eq(playbookBullets.workspaceId, workspaceId), eq(playbookBullets.id, id)))
      .returning({ id: playbookBullets.id });
    return rows.length > 0;
  }

  /** Increment one counter in place. The counters are never set, only raised. */
  private async bump(
    workspaceId: string,
    id: string,
    column: "helpful" | "harmful",
    now: number,
  ): Promise<void> {
    const target = column === "helpful" ? playbookBullets.helpful : playbookBullets.harmful;
    await this.dbImpl
      .update(playbookBullets)
      .set({ [column]: sql`${target} + 1`, updatedAt: now } as any)
      .where(and(eq(playbookBullets.workspaceId, workspaceId), eq(playbookBullets.id, id)));
  }
}

/** Default app-wide store. */
export const playbookStore: PlaybookStore = new SqlitePlaybookStore();
