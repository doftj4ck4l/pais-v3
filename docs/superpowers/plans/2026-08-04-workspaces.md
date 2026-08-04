# Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a workspace as the container for agents, documents, databases, and produced files, so a set of related work is isolated from everything else.

**Architecture:** A `workspaces` table becomes the scoping key that `user_id` is today. Every scoped table gains `workspace_id`; every request carries one. The sandbox directory moves from `SANDBOX_ROOT/<userId>` to `SANDBOX_ROOT/<workspaceId>`, which resolves the existing naming collision — the sandbox "workspace" and the new domain concept become the same thing rather than two meanings of one word. `user_id` stays on `workspaces` alone, as the ownership root.

**Tech Stack:** Bun, Hono, Drizzle + SQLite (`bun:sqlite`), React 19, Vite, Tailwind v4.

## Global Constraints

- Runtime is Bun. Tests are `bun test`; assertions use `bun:test`.
- Schema is created by `ensureSchema()` in `apps/api/src/db/client.ts`, not by migration files. `applySchema(target)` takes a handle so tests build the real schema in memory.
- Repositories are the only modules that touch tables. Controllers do HTTP in/out only.
- Every existing test must still pass: **245 tests across 16 files** at the time of writing.
- No secret or connection string may reach the client or the model. `db_connections.secret` stays server-side.
- Existing user data must survive. Workspaces are never deleted implicitly — the sandbox docs promise a file written today is still there next week.

---

## Naming

"Workspace" currently means the sandbox directory (`workspace.repository.ts`, `workspace.controller.ts`, `/api/workspace/files`). After this plan it means the domain container, and the sandbox directory is that container's file storage. The existing modules keep their names and simply re-scope — no rename is needed, because the two meanings collapse into one.

## File Structure

**Create**
- `apps/api/src/repositories/workspace-registry.repository.ts` — CRUD for `workspaces`, and resolving a request to one. Named `-registry` to distinguish it from `workspace.repository.ts`, which owns sandbox *files*.
- `apps/api/src/repositories/workspace-registry.repository.test.ts`
- `apps/api/src/controllers/workspace-registry.controller.ts` — `/api/workspaces`
- `apps/api/src/routes/workspace-registry.routes.ts`
- `apps/api/src/db/backfill.ts` — one-time move of existing rows into a default workspace
- `apps/api/src/db/backfill.test.ts`
- `apps/web/src/hooks/use-workspace.ts` — current workspace id, persisted
- `apps/web/src/components/workspace-switcher.tsx`

**Modify**
- `apps/api/src/models/schema.ts` — `workspaces` table; `workspaceId` on `conversations`, `documents`, `chunks`, `db_connections`, `db_tables`, `db_columns`, `memory_notes`, `sandboxes`
- `apps/api/src/db/client.ts` — DDL, indexes, and call `backfill()` from `ensureSchema()`
- `apps/api/src/repositories/{conversation,document,database-connection,memory,sandbox,workspace}.repository.ts` — scope by `workspaceId`
- `apps/api/src/services/{search,ingest,context-tools,db-tools,memory,pi,agent}.service.ts` and `services/db/introspect.service.ts` — thread `workspaceId`
- `apps/api/src/services/sandbox/sandbox.service.ts` — container and directory per workspace
- `apps/api/src/controllers/{chat,conversation,document,database,workspace}.controller.ts` — read `workspaceId`
- `apps/api/src/types/agent.ts` — `ChatRequest.workspaceId`
- `apps/web/src/lib/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/hooks/use-agent-board.ts`, resource panels

---

### Task 1: Workspaces table and backfill

**Files:**
- Modify: `apps/api/src/models/schema.ts`
- Modify: `apps/api/src/db/client.ts`
- Create: `apps/api/src/db/backfill.ts`
- Test: `apps/api/src/db/backfill.test.ts`

**Interfaces:**
- Produces: `workspaces` table; `WorkspaceRow = { id, userId, name, createdAt }`; `backfill(target: Database): void`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/src/db/backfill.test.ts
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "./client";
import { backfill } from "./backfill";

function seeded() {
  const db = new Database(":memory:");
  applySchema(db);
  db.run(`INSERT INTO users (id, created_at) VALUES ('u1', 1)`);
  db.run(
    `INSERT INTO conversations (id, user_id, title, model_id, harness_id, status, created_at, updated_at)
     VALUES ('c1','u1','t','m','h','done',1,1)`,
  );
  db.run(
    `INSERT INTO documents (id, user_id, title, bytes, pages, chunk_count, status, created_at)
     VALUES ('d1','u1','a.pdf',1,1,1,'indexed',1)`,
  );
  return db;
}

describe("backfill", () => {
  it("gives each existing user one workspace and moves their rows into it", () => {
    const db = seeded();
    backfill(db);

    const ws = db.query<{ id: string; user_id: string; name: string }, []>(
      `SELECT id, user_id, name FROM workspaces`,
    ).all();
    expect(ws).toHaveLength(1);
    expect(ws[0]!.user_id).toBe("u1");

    const conv = db.query<{ workspace_id: string }, []>(
      `SELECT workspace_id FROM conversations WHERE id = 'c1'`,
    ).get();
    expect(conv!.workspace_id).toBe(ws[0]!.id);

    const doc = db.query<{ workspace_id: string }, []>(
      `SELECT workspace_id FROM documents WHERE id = 'd1'`,
    ).get();
    expect(doc!.workspace_id).toBe(ws[0]!.id);
  });

  it("is idempotent — a second run creates no extra workspace", () => {
    const db = seeded();
    backfill(db);
    backfill(db);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM workspaces`).get()!.n,
    ).toBe(1);
  });

  it("does nothing on an empty database", () => {
    const db = new Database(":memory:");
    applySchema(db);
    backfill(db);
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM workspaces`).get()!.n,
    ).toBe(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/db/backfill.test.ts`
Expected: FAIL — `Cannot find module './backfill'`

- [x] **Step 3: Add the table and columns**

In `apps/api/src/models/schema.ts`, append:

```ts
/** A container for one body of work: its agents, documents, databases and files. */
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
```

Add `workspaceId: text("workspace_id")` to `conversations`, `documents`, `chunks`, `dbConnections`, `dbTables`, `dbColumns`, `memoryNotes`, and `sandboxes`, and add it to each corresponding exported `Row` type as `workspaceId: string`.

Leave `user_id` on those tables for now — dropping a column in SQLite means rebuilding the table, and the backfill needs it to find each row's owner. Task 10 removes the reads; the columns can be dropped later.

- [x] **Step 4: Add DDL and indexes**

In `applySchema()` in `apps/api/src/db/client.ts`, add to the main `exec` block:

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces (user_id, created_at);
```

Then, after that block, add the columns idempotently. `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in SQLite, so it is guarded:

```ts
// Existing databases predate workspace scoping. ALTER has no IF NOT EXISTS,
// so each column is added only when the table does not already have it.
const SCOPED = [
  "conversations", "documents", "chunks", "db_connections",
  "db_tables", "db_columns", "memory_notes", "sandboxes",
] as const;

for (const table of SCOPED) {
  const columns = target
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!columns.includes("workspace_id")) {
    target.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
  }
  target.exec(
    `CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table} (workspace_id)`,
  );
}
```

- [x] **Step 5: Write the backfill**

```ts
// apps/api/src/db/backfill.ts
import type { Database } from "bun:sqlite";

const SCOPED = [
  "conversations", "documents", "chunks", "db_connections",
  "db_tables", "db_columns", "memory_notes", "sandboxes",
] as const;

/**
 * Move pre-workspace rows into one workspace per user.
 *
 * Runs on every boot and does nothing once every row is scoped, so it is safe
 * to leave in place. It never deletes: a user's existing agents, documents and
 * connections all land in their default workspace rather than being orphaned.
 */
export function backfill(target: Database): void {
  const orphans = target
    .query<{ user_id: string }, []>(
      `SELECT DISTINCT user_id FROM (
         ${SCOPED.map((t) => `SELECT user_id FROM ${t} WHERE workspace_id IS NULL`).join(" UNION ")}
       ) WHERE user_id IS NOT NULL`,
    )
    .all();

  for (const { user_id } of orphans) {
    const existing = target
      .query<{ id: string }, [string]>(
        `SELECT id FROM workspaces WHERE user_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(user_id);

    let workspaceId = existing?.id;
    if (!workspaceId) {
      workspaceId = `ws_${user_id.slice(0, 8)}_${Math.random().toString(36).slice(2, 8)}`;
      target.run(
        `INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`,
        [workspaceId, user_id, "Default", Date.now()],
      );
    }

    for (const table of SCOPED) {
      target.run(
        `UPDATE ${table} SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL`,
        [workspaceId, user_id],
      );
    }
  }
}
```

Call it at the end of `ensureSchema()`:

```ts
export function ensureSchema() {
  applySchema(sqlite);
  backfill(sqlite);
}
```

- [x] **Step 6: Run tests**

Run: `cd apps/api && bun test src/db/backfill.test.ts`
Expected: PASS, 3 tests

- [x] **Step 7: Confirm nothing else broke**

Run: `cd apps/api && bunx tsc --noEmit && bun test`
Expected: typecheck clean, 248 pass

- [x] **Step 8: Commit**

```bash
git add apps/api/src/models/schema.ts apps/api/src/db/client.ts apps/api/src/db/backfill.ts apps/api/src/db/backfill.test.ts
git commit -m "feat: workspaces table and backfill of existing rows"
```

---

### Task 2: Workspace registry repository

**Files:**
- Create: `apps/api/src/repositories/workspace-registry.repository.ts`
- Test: `apps/api/src/repositories/workspace-registry.repository.test.ts`

**Interfaces:**
- Consumes: `workspaces` table from Task 1
- Produces: `workspaceRegistry` with
  `create(userId: string, name: string): Promise<WorkspaceRow>`,
  `list(userId: string): Promise<WorkspaceRow[]>`,
  `getOwned(id: string, userId: string): Promise<WorkspaceRow | undefined>`,
  `rename(id: string, userId: string, name: string): Promise<boolean>`,
  `remove(id: string, userId: string): Promise<boolean>`,
  `resolve(userId: string, requested?: string): Promise<WorkspaceRow>`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/src/repositories/workspace-registry.repository.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteWorkspaceRegistry } from "./workspace-registry.repository";

let registry: SqliteWorkspaceRegistry;
let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  registry = new SqliteWorkspaceRegistry(drizzle(sqlite) as any);
});

describe("workspace registry", () => {
  it("creates and lists a workspace", async () => {
    const created = await registry.create("u1", "Research");
    expect(created.name).toBe("Research");
    expect(await registry.list("u1")).toHaveLength(1);
  });

  it("keeps users apart", async () => {
    await registry.create("u1", "Mine");
    expect(await registry.list("u2")).toEqual([]);
  });

  it("refuses to return another user's workspace", async () => {
    const mine = await registry.create("u1", "Mine");
    expect(await registry.getOwned(mine.id, "u2")).toBeUndefined();
  });

  it("resolve creates a default when the user has none", async () => {
    const resolved = await registry.resolve("u1");
    expect(resolved.name).toBe("Default");
    expect(await registry.list("u1")).toHaveLength(1);
  });

  it("resolve returns the requested workspace when it is owned", async () => {
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    expect((await registry.resolve("u1", a.id)).id).toBe(a.id);
  });

  it("resolve falls back to the user's first workspace for an unowned id", async () => {
    const mine = await registry.create("u1", "Mine");
    const theirs = await registry.create("u2", "Theirs");
    // A forged or stale id must not reach into another user's data.
    expect((await registry.resolve("u1", theirs.id)).id).toBe(mine.id);
  });

  it("renames only its owner's workspace", async () => {
    const mine = await registry.create("u1", "Old");
    expect(await registry.rename(mine.id, "u2", "Hacked")).toBe(false);
    expect(await registry.rename(mine.id, "u1", "New")).toBe(true);
    expect((await registry.list("u1"))[0]!.name).toBe("New");
  });

  it("refuses to remove the last workspace", async () => {
    const only = await registry.create("u1", "Only");
    // There must always be somewhere for a run to go.
    expect(await registry.remove(only.id, "u1")).toBe(false);
  });

  it("removes a workspace when another remains", async () => {
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    expect(await registry.remove(a.id, "u1")).toBe(true);
    expect(await registry.list("u1")).toHaveLength(1);
  });

  it("takes the workspace's rows with it", async () => {
    // Scoped tables have no foreign key to workspaces, so a row left behind
    // would still match a search while being unreachable from the UI.
    const a = await registry.create("u1", "A");
    await registry.create("u1", "B");
    sqlite.run(
      `INSERT INTO documents (id, workspace_id, title, bytes, pages, chunk_count, status, created_at)
       VALUES ('d1', ?, 'a.pdf', 1, 1, 1, 'indexed', 1)`,
      [a.id],
    );

    await registry.remove(a.id, "u1");
    expect(
      sqlite.query<{ n: number }, []>(`SELECT COUNT(*) n FROM documents`).get()!.n,
    ).toBe(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/repositories/workspace-registry.repository.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Implement**

```ts
// apps/api/src/repositories/workspace-registry.repository.ts
import { and, eq, sql } from "drizzle-orm";
import { db, workspaces } from "../db/client";
import type { WorkspaceRow } from "../models/schema";

const genId = () =>
  `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export interface WorkspaceRegistry {
  create(userId: string, name: string): Promise<WorkspaceRow>;
  list(userId: string): Promise<WorkspaceRow[]>;
  getOwned(id: string, userId: string): Promise<WorkspaceRow | undefined>;
  rename(id: string, userId: string, name: string): Promise<boolean>;
  remove(id: string, userId: string): Promise<boolean>;
  resolve(userId: string, requested?: string): Promise<WorkspaceRow>;
}

/**
 * Workspaces and the rule for picking one.
 *
 * Ownership is checked here rather than by callers, because every scoped query
 * downstream trusts the workspace id it is handed. If a forged id could get
 * past this module, it would reach documents, connections and transcripts.
 */
export class SqliteWorkspaceRegistry implements WorkspaceRegistry {
  constructor(private readonly dbImpl: typeof db = db) {}

  async create(userId: string, name: string): Promise<WorkspaceRow> {
    const row: WorkspaceRow = {
      id: genId(),
      userId,
      name: name.trim() || "Untitled",
      createdAt: Date.now(),
    };
    await this.dbImpl.insert(workspaces).values(row);
    return row;
  }

  async list(userId: string): Promise<WorkspaceRow[]> {
    return (await this.dbImpl
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, userId))
      .orderBy(sql`created_at asc`)) as WorkspaceRow[];
  }

  async getOwned(id: string, userId: string): Promise<WorkspaceRow | undefined> {
    const rows = await this.dbImpl
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
      .limit(1);
    return rows[0] as WorkspaceRow | undefined;
  }

  async rename(id: string, userId: string, name: string): Promise<boolean> {
    if (!(await this.getOwned(id, userId))) return false;
    await this.dbImpl
      .update(workspaces)
      .set({ name: name.trim() || "Untitled" })
      .where(eq(workspaces.id, id));
    return true;
  }

  async remove(id: string, userId: string): Promise<boolean> {
    if (!(await this.getOwned(id, userId))) return false;
    // A user always needs somewhere for the next run to go, and removing the
    // last one would strand every row the backfill would then re-orphan.
    if ((await this.list(userId)).length <= 1) return false;

    // Scoped tables have no foreign key to workspaces, so removing the row
    // alone would leave documents, conversations and connections unreachable
    // but still present — invisible rows that still match a search. They are
    // deleted explicitly, in one transaction with the workspace.
    this.dbImpl.transaction((tx) => {
      tx.run(sql`DELETE FROM chunks_fts WHERE document_id IN
                   (SELECT id FROM documents WHERE workspace_id = ${id})`);
      tx.run(sql`DELETE FROM db_schema_fts WHERE workspace_id = ${id}`);
      for (const table of [
        "messages", "traces", // reached via conversation_id below
      ]) {
        tx.run(
          sql`DELETE FROM ${sql.raw(table)} WHERE conversation_id IN
                (SELECT id FROM conversations WHERE workspace_id = ${id})`,
        );
      }
      for (const table of [
        "documents", "chunks", "db_columns", "db_tables",
        "db_connections", "memory_notes", "conversations", "sandboxes",
      ]) {
        tx.run(sql`DELETE FROM ${sql.raw(table)} WHERE workspace_id = ${id}`);
      }
      tx.delete(workspaces).where(eq(workspaces.id, id)).run();
    });
    return true;
  }

  /**
   * The workspace a request applies to. An unknown or unowned id falls back to
   * the user's first workspace rather than erroring — a client may hold an id
   * that was deleted in another tab.
   */
  async resolve(userId: string, requested?: string): Promise<WorkspaceRow> {
    if (requested) {
      const owned = await this.getOwned(requested, userId);
      if (owned) return owned;
    }
    const existing = await this.list(userId);
    return existing[0] ?? (await this.create(userId, "Default"));
  }
}

export const workspaceRegistry: WorkspaceRegistry = new SqliteWorkspaceRegistry();
```

Export `workspaces` and `WorkspaceRow` from `apps/api/src/db/client.ts` alongside the other tables.

- [x] **Step 4: Run tests**

Run: `cd apps/api && bun test src/repositories/workspace-registry.repository.test.ts`
Expected: PASS, 9 tests

- [x] **Step 5: Commit**

```bash
git add apps/api/src/repositories/workspace-registry.repository.ts apps/api/src/repositories/workspace-registry.repository.test.ts apps/api/src/db/client.ts
git commit -m "feat: workspace registry with ownership-checked resolution"
```

---

### Task 3: Workspace endpoints

**Files:**
- Create: `apps/api/src/controllers/workspace-registry.controller.ts`
- Create: `apps/api/src/routes/workspace-registry.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

**Interfaces:**
- Consumes: `workspaceRegistry` from Task 2
- Produces: `GET /api/workspaces`, `POST /api/workspaces`, `PATCH /api/workspaces/:id`, `DELETE /api/workspaces/:id`

- [x] **Step 1: Write the controller**

```ts
// apps/api/src/controllers/workspace-registry.controller.ts
import type { Context } from "hono";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { env } from "../config/env";

const userIdOf = (c: Context) => c.req.query("userId") ?? env.defaultUserId;

/** GET /api/workspaces — a user's workspaces, oldest first, creating one if none exist. */
export async function index(c: Context) {
  const userId = userIdOf(c);
  // Resolving first guarantees the client always has at least one to select.
  await workspaceRegistry.resolve(userId);
  return c.json({ workspaces: await workspaceRegistry.list(userId) });
}

export async function create(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const workspace = await workspaceRegistry.create(userIdOf(c), body.name ?? "Untitled");
  return c.json({ workspace }, 201);
}

export async function update(c: Context) {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  if (!id || !body.name) return c.json({ error: "Missing id or name" }, 400);
  const renamed = await workspaceRegistry.rename(id, userIdOf(c), body.name);
  if (!renamed) return c.json({ error: "Workspace not found" }, 404);
  return c.body(null, 204);
}

export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);
  const removed = await workspaceRegistry.remove(id, userIdOf(c));
  // Also 409 when it is the last one — the client needs to tell those apart.
  if (!removed) {
    const still = await workspaceRegistry.getOwned(id, userIdOf(c));
    if (still) return c.json({ error: "Cannot remove the last workspace" }, 409);
    return c.json({ error: "Workspace not found" }, 404);
  }
  return c.body(null, 204);
}
```

- [x] **Step 2: Add routes**

```ts
// apps/api/src/routes/workspace-registry.routes.ts
import { Hono } from "hono";
import * as controller from "../controllers/workspace-registry.controller";

export const workspaceRegistryRoutes = new Hono();

workspaceRegistryRoutes.get("/", controller.index);
workspaceRegistryRoutes.post("/", controller.create);
workspaceRegistryRoutes.patch("/:id", controller.update);
workspaceRegistryRoutes.delete("/:id", controller.destroy);
```

In `apps/api/src/routes/index.ts`, import it and add:

```ts
apiRoutes.route("/workspaces", workspaceRegistryRoutes);
```

- [x] **Step 3: Verify by hand**

```bash
cd /home/farhan/dev/salur && bun run dev
# in another shell:
curl -s "http://localhost:4000/api/workspaces?userId=t1" | python3 -m json.tool
curl -s -X POST "http://localhost:4000/api/workspaces?userId=t1" \
  -H 'Content-Type: application/json' -d '{"name":"Research"}' | python3 -m json.tool
```

Expected: the first call returns one workspace named `Default`; the second returns a second named `Research`.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/controllers/workspace-registry.controller.ts apps/api/src/routes/
git commit -m "feat: workspace endpoints"
```

---

### Task 4: Scope documents and retrieval

**Files:**
- Modify: `apps/api/src/repositories/document.repository.ts`
- Modify: `apps/api/src/services/{ingest,search,context-tools}.service.ts` (note: `context-tools.ts` has no `.service` suffix)
- Test: `apps/api/src/services/search.service.test.ts`, `apps/api/src/services/ingest.service.test.ts`

**Interfaces:**
- Consumes: `workspace_id` column from Task 1
- Produces: `DocumentStore` methods keyed by `workspaceId` —
  `save(doc: NewDocument & { workspaceId: string }, chunks: Chunk[])`,
  `list(workspaceId: string)`, `remove(workspaceId: string, documentId: string)`,
  `search(workspaceId: string, ftsQuery: string, limit: number)`;
  `searchDocuments(workspaceId, rawQuery, limit, store)`;
  `ingestPdf(workspaceId, title, bytes, store)`;
  `createDocumentTools(workspaceId, store)`

- [x] **Step 1: Update the existing tests to the new key**

In `search.service.test.ts` and `ingest.service.test.ts`, replace the `userId` argument with a workspace id throughout, and add:

```ts
it("never returns another workspace's chunks", async () => {
  const store = freshStore();
  await store.save(
    { id: "d1", workspaceId: "ws1", title: "a.pdf", bytes: 1, pages: 1, status: "indexed" },
    [{ seq: 0, page: 1, text: "enterprise refund window" }],
  );
  const res = await searchDocuments("ws2", "refund", 5, store);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.hits).toEqual([]);
});
```

- [x] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun test src/services/search.service.test.ts`
Expected: FAIL — argument type mismatch

- [x] **Step 3: Re-scope the repository**

In `document.repository.ts`, replace every `userId` parameter and predicate with `workspaceId`:

```ts
// documents and chunks both carry workspace_id; chunks keeps its own copy so
// search filters without a join, exactly as it did with user_id.
.where(eq(documents.workspaceId, workspaceId))
```

and in `search`:

```sql
WHERE chunks_fts MATCH ${ftsQuery}
  AND c.workspace_id = ${workspaceId}
  AND d.status = 'indexed'
```

- [x] **Step 4: Thread it through the services**

`ingestPdf(workspaceId, ...)` writes `workspaceId` on the document and every chunk. `searchDocuments(workspaceId, ...)` passes it to `store.search`. `createDocumentTools(workspaceId, store)` closes over it.

- [x] **Step 5: Run tests**

Run: `cd apps/api && bun test src/services/`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add apps/api/src/repositories/document.repository.ts apps/api/src/services/
git commit -m "feat: scope documents and retrieval to a workspace"
```

---

### Task 5: Scope database connections

**Files:**
- Modify: `apps/api/src/repositories/database-connection.repository.ts`
- Modify: `apps/api/src/services/db/introspect.service.ts`, `apps/api/src/services/db-tools.ts`
- Test: `apps/api/src/repositories/database-connection.repository.test.ts`, `apps/api/src/services/db-tools.test.ts`

**Interfaces:**
- Produces: connection store and `db_tables` / `db_columns` snapshot rows keyed by `workspaceId`; `createDatabaseTools(workspaceId)`

- [x] **Step 1: Update tests to workspace ids and add an isolation case**

```ts
it("does not surface another workspace's tables", async () => {
  await store.create({ workspaceId: "ws1", name: "prod", url: "postgres://x/y" });
  const found = await searchSchema("ws2", "orders");
  expect(found).toEqual([]);
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd apps/api && bun test src/repositories/database-connection.repository.test.ts`
Expected: FAIL

- [x] **Step 3: Re-scope**

Replace `userId` with `workspaceId` in the connection repository, the snapshot writer in `introspect.service.ts`, and the three tools in `db-tools.ts`. The `db_schema_fts` query gains `AND t.workspace_id = ?` the same way `chunks_fts` did.

`secret` stays server-side — no change to what is selected into responses.

- [x] **Step 4: Run tests**

Run: `cd apps/api && bun test src/`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/api/src/repositories/database-connection.repository.ts apps/api/src/services/db/ apps/api/src/services/db-tools.ts
git commit -m "feat: scope database connections and schema snapshots to a workspace"
```

---

### Task 6: Scope conversations and memory

**Files:**
- Modify: `apps/api/src/repositories/conversation.repository.ts`, `apps/api/src/repositories/memory.repository.ts`
- Modify: `apps/api/src/services/memory.service.ts`
- Modify: `apps/api/src/controllers/conversation.controller.ts`

**Interfaces:**
- Produces: `conversationRepository.list(workspaceId)`, `create({ workspaceId, ... })`, `getOwned(conversationId, workspaceId)`; `createMemoryTools(workspaceId, store)`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/src/repositories/conversation.repository.test.ts (new file)
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";

describe("conversation scoping", () => {
  it("lists only the given workspace's conversations", async () => {
    const sqlite = new Database(":memory:");
    applySchema(sqlite);
    sqlite.run(`INSERT INTO users (id, created_at) VALUES ('u1', 1)`);
    for (const [id, ws] of [["c1", "ws1"], ["c2", "ws2"]] as const) {
      sqlite.run(
        `INSERT INTO conversations (id, user_id, workspace_id, title, model_id, harness_id, status, created_at, updated_at)
         VALUES (?, 'u1', ?, 't', 'm', 'h', 'done', 1, 1)`,
        [id, ws],
      );
    }
    const rows = sqlite
      .query<{ id: string }, [string]>(`SELECT id FROM conversations WHERE workspace_id = ?`)
      .all("ws1");
    expect(rows.map((r) => r.id)).toEqual(["c1"]);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/repositories/conversation.repository.test.ts`
Expected: FAIL — `workspace_id` has no value, so the row is not matched

- [x] **Step 3: Re-scope**

`create()` takes and stores `workspaceId`. `list()` filters on it. `getOwned(conversationId, workspaceId)` replaces the `userId` check — ownership now runs through the workspace, which the registry has already verified belongs to the user.

`memory.repository.ts` and `createMemoryTools` swap `userId` for `workspaceId`, so notes belong to the body of work rather than the browser.

- [x] **Step 4: Run tests**

Run: `cd apps/api && bun test src/`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/api/src/repositories/ apps/api/src/services/memory.service.ts apps/api/src/controllers/conversation.controller.ts
git commit -m "feat: scope conversations and memory to a workspace"
```

---

### Task 7: One sandbox per workspace

**Files:**
- Modify: `apps/api/src/services/sandbox/sandbox.service.ts`
- Modify: `apps/api/src/repositories/sandbox.repository.ts`
- Modify: `apps/api/src/repositories/workspace.repository.ts` (sandbox files)
- Modify: `apps/api/src/controllers/workspace.controller.ts`
- Test: `apps/api/src/repositories/sandbox.repository.test.ts`, `apps/api/src/repositories/workspace.repository.test.ts`

**Interfaces:**
- Produces: `sandboxService.acquire(workspaceId)` returning `{ containerId, workspacePath }` where `workspacePath = SANDBOX_ROOT/<workspaceId>`; container named `salurai-<workspaceId>`; `list(workspaceId)` and `resolve(workspaceId, path)` for files

- [x] **Step 1: Update the file-guard tests to workspace ids**

In `workspace.repository.test.ts`, replace `const USER = "u1"` with `const WS = "ws1"` and update every call. The guard logic is unchanged — only the directory name is.

- [x] **Step 2: Run to verify failure**

Run: `cd apps/api && bun test src/repositories/workspace.repository.test.ts`
Expected: FAIL — argument name/type mismatch

- [x] **Step 3: Re-scope the sandbox**

In `sandbox.service.ts`:

```ts
const workspacePath = existing?.workspacePath ?? path.join(env.sandboxRoot, workspaceId);
```

and `containerNameFor(workspaceId)`. In `sandbox.repository.ts`, the primary key becomes `workspace_id`; keep the column name `user_id` untouched for now and add `workspace_id`, selecting on the latter.

In `workspace.repository.ts` (files), `workspaceRoot(workspaceId)` becomes `path.join(env.sandboxRoot, workspaceId)`.

- [x] **Step 4: Move existing sandbox directories**

Add to `backfill.ts`, after the row updates:

```ts
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env";

/**
 * Sandbox directories were named by user; they are named by workspace now.
 * Renamed rather than recreated — a workspace's files are meant to outlive
 * everything, so losing them here would break the one promise the sandbox
 * makes.
 */
export function migrateSandboxDirs(target: Database): void {
  const rows = target
    .query<{ user_id: string; workspace_id: string }, []>(
      `SELECT user_id, workspace_id FROM sandboxes WHERE workspace_id IS NOT NULL`,
    )
    .all();

  for (const { user_id, workspace_id } of rows) {
    const from = path.join(env.sandboxRoot, user_id);
    const to = path.join(env.sandboxRoot, workspace_id);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  }
}
```

Call it from `backfill()` after the `UPDATE` loop.

- [x] **Step 5: Run tests**

Run: `cd apps/api && bun test src/`
Expected: PASS (sandbox/docker tests need the Docker daemon running)

- [x] **Step 6: Verify a real container**

```bash
cd /home/farhan/dev/salur && bun run dev
curl -s "http://localhost:4000/api/workspaces?userId=t1"   # note the id
# start an agent in that workspace, then:
docker ps --filter "name=salurai-" --format '{{.Names}}'
ls ~/salurai-workspaces/
```

Expected: the container and the directory are both named after the workspace id, not the user id.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/services/sandbox/ apps/api/src/repositories/ apps/api/src/controllers/workspace.controller.ts apps/api/src/db/backfill.ts
git commit -m "feat: one sandbox and file workspace per workspace"
```

---

### Task 8: Thread workspaceId through the run

**Files:**
- Modify: `apps/api/src/types/agent.ts`
- Modify: `apps/api/src/controllers/chat.controller.ts`
- Modify: `apps/api/src/services/agent.service.ts`, `apps/api/src/services/pi.service.ts`
- Modify: `apps/api/src/controllers/{document,database}.controller.ts`

**Interfaces:**
- Consumes: `workspaceRegistry.resolve` from Task 2
- Produces: `ChatRequest.workspaceId?: string`; `AgentOptions.workspaceId: string`; `runPiAgent({ ..., workspaceId })`

- [x] **Step 1: Add the field**

In `apps/api/src/types/agent.ts`:

```ts
export type ChatRequest = {
  conversationId?: string;
  /** Which workspace this run belongs to. Resolved server-side when absent. */
  workspaceId?: string;
  harnessId?: string;
  // ...unchanged
};
```

- [x] **Step 2: Resolve once per request**

In `chat.controller.ts`, immediately after `const userId = ...`:

```ts
// Resolved here, once. Every tool and repository below takes the workspace id
// rather than the user id, so this is the single place a client-supplied value
// is checked against ownership.
const workspace = await workspaceRegistry.resolve(userId, body.workspaceId);
```

Pass `workspace.id` to `conversationRepository.create`, `getOwned`, and `runAgent`.

Do the same in `document.controller.ts`, `database.controller.ts`, and `workspace.controller.ts`, reading `c.req.query("workspaceId")`.

- [x] **Step 3: Thread into the runtime**

`runPiAgent` takes `workspaceId` and uses it for `sandboxService.acquire`, `createDocumentTools`, `createMemoryTools`, `createDatabaseTools`, and the docs prompt.

- [x] **Step 4: Verify end to end**

```bash
cd /home/farhan/dev/salur && bun run dev
WS=$(curl -s "http://localhost:4000/api/workspaces?userId=t1" | python3 -c "import sys,json;print(json.load(sys.stdin)['workspaces'][0]['id'])")
curl -sN --max-time 90 -X POST http://localhost:4000/api/chat -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"harnessId\":\"pi\",\"modelId\":\"gw-qwen3.5-397b-instruct\",\"userId\":\"t1\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the current UTC time? Use a tool.\"}]}" \
  | grep -a '"type":"tool_result"'
```

Expected: a `get_current_time` result, and `~/salurai-workspaces/$WS/` exists.

- [x] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat: resolve and thread workspaceId through every run"
```

---

### Task 9: Workspace switcher in the console

**Files:**
- Create: `apps/web/src/hooks/use-workspace.ts`
- Create: `apps/web/src/components/workspace-switcher.tsx`
- Modify: `apps/web/src/lib/{api,types}.ts`, `apps/web/src/App.tsx`, `apps/web/src/hooks/use-agent-board.ts`, `apps/web/src/components/{control-deck,document-panel,database-panel,files-panel}.tsx`

**Interfaces:**
- Consumes: `/api/workspaces` from Task 3
- Produces: `useWorkspace()` returning `{ workspaces, current, setCurrent, create, rename, remove, loading }`

- [x] **Step 1: Add the hook**

```ts
// apps/web/src/hooks/use-workspace.ts
import { useCallback, useEffect, useState } from 'react'
import { createWorkspace, listWorkspaces } from '@/lib/api'
import { getUserId } from '@/lib/user'
import type { WorkspaceRow } from '@/lib/types'

const KEY = 'salurai-workspace'

/**
 * Which workspace the console is showing.
 *
 * Persisted so a reload returns to the same body of work. The stored id is
 * verified against the server's list before use — it may name a workspace that
 * was removed in another tab, and silently showing an empty console would look
 * like data loss.
 */
export function useWorkspace() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [current, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const userId = getUserId()

  const refresh = useCallback(async () => {
    const rows = await listWorkspaces(userId)
    setWorkspaces(rows)
    setCurrentId((prev) => {
      const saved = prev ?? localStorage.getItem(KEY)
      const valid = rows.some((w) => w.id === saved)
      return valid ? saved! : (rows[0]?.id ?? null)
    })
    setLoading(false)
    return rows
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setCurrent = useCallback((id: string) => {
    setCurrentId(id)
    localStorage.setItem(KEY, id)
  }, [])

  const create = useCallback(
    async (name: string) => {
      const created = await createWorkspace(userId, name)
      await refresh()
      setCurrent(created.id)
      return created
    },
    [userId, refresh, setCurrent],
  )

  return { workspaces, current, setCurrent, create, loading }
}
```

- [x] **Step 2: Add the API client functions**

```ts
// apps/web/src/lib/api.ts
export async function listWorkspaces(userId: string): Promise<WorkspaceRow[]> {
  const { workspaces } = await json<{ workspaces: WorkspaceRow[] }>(
    await fetch(`/api/workspaces?userId=${encodeURIComponent(userId)}`),
  )
  return workspaces
}

export async function createWorkspace(userId: string, name: string): Promise<WorkspaceRow> {
  const { workspace } = await json<{ workspace: WorkspaceRow }>(
    await fetch(`/api/workspaces?userId=${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return workspace
}
```

and in `types.ts`:

```ts
export type WorkspaceRow = {
  id: string
  userId: string
  name: string
  createdAt: number
}
```

- [x] **Step 3: Pass workspaceId on every scoped call**

Add `workspaceId` to the query string of `listConversations`, `listDocuments`, `uploadDocuments`, `deleteDocument`, `listWorkspaceFiles`, `workspaceFileUrl`, and the database functions; add it to the `/api/chat` body in `use-agent-board.ts`.

- [x] **Step 4: Add the switcher**

Place it directly under the wordmark in `control-deck.tsx` — it is the frame everything below sits in, so it belongs above the agent list rather than inside the settings modal.

```tsx
// apps/web/src/components/workspace-switcher.tsx
import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { WorkspaceRow } from '@/lib/types'

/**
 * Which body of work the console is showing. Everything below it — agents,
 * documents, databases, files — belongs to the selection.
 */
export function WorkspaceSwitcher({
  workspaces, current, onSelect, onCreate,
}: {
  workspaces: WorkspaceRow[]
  current: string | null
  onSelect: (id: string) => void
  onCreate: (name: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  if (adding) {
    return (
      <form
        className="flex items-center gap-1.5 border-b px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onCreate(name.trim())
          setName('')
          setAdding(false)
        }}
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setAdding(false)}
          placeholder="Workspace name"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
        />
      </form>
    )
  }

  return (
    <div className="flex items-center gap-1.5 border-b px-3 py-2.5">
      <Select value={current ?? undefined} onValueChange={onSelect}>
        <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
          <SelectValue placeholder="Loading…" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setAdding(true)}
        aria-label="New workspace"
        className="shrink-0 text-muted-foreground"
      >
        <PlusIcon />
      </Button>
    </div>
  )
}
```

- [x] **Step 5: Re-fetch everything on switch**

In `App.tsx`, key the board and the resource panels on the workspace so switching remounts them:

```tsx
<ResourcesPanel key={workspace.current ?? 'none'} … />
```

and in `use-agent-board.ts`, re-run the conversation restore whenever `workspaceId` changes. Without this the previous workspace's agents stay on screen.

- [x] **Step 6: Verify**

```bash
cd apps/web && bun run build && bun run lint
```

Then in the browser: create a second workspace, confirm the agent list empties, upload a PDF, switch back, and confirm the first workspace's documents are unchanged.

- [x] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat: workspace switcher and per-workspace console state"
```

---

### Task 10: Documentation and cleanup

**Files:**
- Modify: `README.md`
- Modify: `apps/api/src/models/schema.ts`

- [x] **Step 1: Document the model**

Add to `README.md` under Persistence:

```markdown
### Workspaces

A workspace is the container for one body of work: its agents, uploaded
documents, database connections, and the sandbox directory its agents write to.
Everything the console shows belongs to the selected workspace.

Users own workspaces; nothing else is scoped by user. A workspace's sandbox
lives at `SANDBOX_ROOT/<workspaceId>` and its container is `salurai-<workspaceId>`,
so two workspaces never share a filesystem.

Existing data was moved into a `Default` workspace per user on first boot after
the upgrade. That backfill is idempotent and still runs, so a database from
before the change can be opened at any time.
```

- [x] **Step 2: Mark the legacy columns**

Leave `user_id` on the scoped tables but document it, so nobody reads it by accident:

```ts
// Legacy: pre-workspace scoping key, retained so the backfill can still place
// old rows. Nothing reads it — scope by workspaceId.
userId: text("user_id"),
```

- [x] **Step 3: Full verification**

```bash
cd apps/api && bunx tsc --noEmit && bun test
cd ../web && bun run build && bun run lint
```

Expected: typecheck clean, all tests pass, build clean.

- [x] **Step 4: Commit**

```bash
git add README.md apps/api/src/models/schema.ts
git commit -m "docs: document the workspace model"
```

---

## Notes for the implementer

**Why `user_id` stays.** SQLite cannot drop a column without rebuilding the table, and the backfill needs `user_id` to decide where an orphan row belongs. Leaving it costs one unused column and keeps the upgrade reversible. Dropping it is a separate, later change.

**The backfill runs on every boot.** That is deliberate. It is a no-op once every row has a `workspace_id`, and it means a database from before the change can be opened at any point without a manual migration step.

**Ownership has exactly one gate.** `workspaceRegistry.resolve(userId, requested)` is the only place a client-supplied workspace id is checked. Everything downstream trusts it. Do not add a second path that accepts a workspace id without going through it.

**Removing a workspace deletes its rows but not its files.** `remove()` clears
the scoped tables in one transaction, because a row with no reachable workspace
would still match a search. The sandbox directory at `SANDBOX_ROOT/<workspaceId>`
is deliberately left on disk — the sandbox's one promise is that a file written
today is still there later, and honouring that matters more than tidiness. Delete
it by hand if you want the space back.

**Order matters for Tasks 4-7.** Each re-scopes one subsystem and leaves the app working. Do not batch them — a half-migrated repository that still filters by `user_id` while its caller passes a workspace id returns empty results rather than failing, which is hard to spot.
