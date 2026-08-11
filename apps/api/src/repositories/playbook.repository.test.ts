import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqlitePlaybookStore } from "./playbook.repository";

let sqlite: Database;
let store: SqlitePlaybookStore;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  store = new SqlitePlaybookStore(drizzle(sqlite) as never);
});

describe("apply", () => {
  it("adds a bullet and starts its counters at zero", async () => {
    const result = await store.apply("ws1", "run1", [
      { op: "add", kind: "fact", content: "The Plane workspace is at https://plane.example/hq" },
    ]);

    expect(result.added).toBe(1);
    const bullets = await store.list("ws1");
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.kind).toBe("fact");
    expect(bullets[0]!.helpful).toBe(0);
    expect(bullets[0]!.harmful).toBe(0);
  });

  it("treats a re-derived bullet as confirmation, not a duplicate", async () => {
    await store.apply("ws1", "run1", [
      { op: "add", kind: "route", content: "Create a Plane task with plane__create_work_item." },
    ]);
    // Same claim, different punctuation and case — the shape a second run
    // produces when it works the fact out again rather than reading it.
    const second = await store.apply("ws1", "run2", [
      { op: "add", kind: "route", content: "create a Plane task with plane__create_work_item" },
    ]);

    expect(second.added).toBe(0);
    expect(second.confirmed).toBe(1);
    const bullets = await store.list("ws1");
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.helpful).toBe(1);
  });

  it("increments counters in place rather than replacing them", async () => {
    await store.apply("ws1", "run1", [{ op: "add", kind: "pitfall", content: "No slug tool exists." }]);
    const id = (await store.list("ws1"))[0]!.id;

    await store.apply("ws1", "run2", [{ op: "helpful", id }]);
    await store.apply("ws1", "run3", [{ op: "helpful", id }]);
    await store.apply("ws1", "run4", [{ op: "harmful", id }]);

    const bullet = (await store.list("ws1"))[0]!;
    expect(bullet.helpful).toBe(2);
    expect(bullet.harmful).toBe(1);
  });

  it("revises a bullet's content", async () => {
    await store.apply("ws1", "run1", [{ op: "add", kind: "fact", content: "Plane is at old.example" }]);
    const id = (await store.list("ws1"))[0]!.id;

    await store.apply("ws1", "run2", [{ op: "revise", id, content: "Plane is at new.example" }]);

    expect((await store.list("ws1"))[0]!.content).toBe("Plane is at new.example");
  });

  it("drops a revision that would collide with another bullet", async () => {
    // Without this the unique fingerprint index rejects the update and the
    // revision is lost silently — two bullets that disagree, one of them stale.
    await store.apply("ws1", "run1", [
      { op: "add", kind: "fact", content: "Alpha" },
      { op: "add", kind: "fact", content: "Beta" },
    ]);
    const bullets = await store.list("ws1");
    const beta = bullets.find((b) => b.content === "Beta")!;

    await store.apply("ws1", "run2", [{ op: "revise", id: beta.id, content: "Alpha" }]);

    const after = await store.list("ws1");
    expect(after.map((b) => b.content).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("keeps workspaces apart", async () => {
    await store.apply("ws1", "run1", [{ op: "add", kind: "fact", content: "Only ws1 knows this" }]);
    expect(await store.list("ws2")).toHaveLength(0);
  });

  it("lets two workspaces hold the same bullet", async () => {
    // The fingerprint index is unique per workspace, not globally. A shared
    // fact would otherwise be learnable exactly once across the whole install.
    await store.apply("ws1", "run1", [{ op: "add", kind: "fact", content: "Shared truth" }]);
    const result = await store.apply("ws2", "run2", [
      { op: "add", kind: "fact", content: "Shared truth" },
    ]);

    expect(result.added).toBe(1);
    expect(await store.list("ws2")).toHaveLength(1);
  });
});

describe("remove", () => {
  it("deletes a bullet and reports it", async () => {
    await store.apply("ws1", "run1", [{ op: "add", kind: "fact", content: "Wrong thing" }]);
    const id = (await store.list("ws1"))[0]!.id;

    expect(await store.remove("ws1", id)).toBe(true);
    expect(await store.list("ws1")).toHaveLength(0);
  });

  it("will not delete another workspace's bullet", async () => {
    await store.apply("ws1", "run1", [{ op: "add", kind: "fact", content: "ws1 only" }]);
    const id = (await store.list("ws1"))[0]!.id;

    expect(await store.remove("ws2", id)).toBe(false);
    expect(await store.list("ws1")).toHaveLength(1);
  });
});
