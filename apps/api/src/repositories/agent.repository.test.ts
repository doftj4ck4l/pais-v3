import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteAgentStore } from "./agent.repository";

let sqlite: Database;
let store: SqliteAgentStore;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  applySchema(sqlite);
  sqlite.run("INSERT INTO users (id, created_at) VALUES ('u1', 1), ('u2', 1)");
  sqlite.run(
    "INSERT INTO workspaces (id, user_id, name, created_at) VALUES ('ws1', 'u1', 'One', 1), ('ws2', 'u2', 'Two', 1)",
  );
  store = new SqliteAgentStore(drizzle(sqlite) as never);
});

const create = (id: string, workspaceId = "ws1", tokenDigest = `digest-${id}`) =>
  store.create({
    id,
    workspaceId,
    name: `Agent ${id}`,
    systemPrompt: "Be helpful.",
    modelId: "model-1",
    tokenDigest,
    tokenHint: tokenDigest.slice(-4),
  });

describe("agent repository", () => {
  it("lists only agents in the selected workspace", async () => {
    await create("a1", "ws1");
    await create("a2", "ws2");

    expect((await store.list("ws1")).map((row) => row.id)).toEqual(["a1"]);
    expect(await store.getOwned("ws2", "a1")).toBeNull();
  });

  it("finds an agent by its token digest without exposing another lookup path", async () => {
    await create("a1", "ws1", "secret-digest");

    expect((await store.findByTokenDigest("secret-digest"))?.id).toBe("a1");
    expect(await store.findByTokenDigest("wrong")).toBeNull();
  });

  it("updates and rotates only an owned agent", async () => {
    await create("a1", "ws1", "old-digest");

    expect(await store.update("ws2", "a1", { name: "Nope" })).toBeNull();
    const rotated = await store.update("ws1", "a1", {
      tokenDigest: "new-digest",
      tokenHint: "new4",
    });

    expect(rotated).toMatchObject({ tokenDigest: "new-digest", tokenHint: "new4" });
    expect(await store.findByTokenDigest("old-digest")).toBeNull();
  });

  it("marks use and deletes without crossing workspaces", async () => {
    await create("a1", "ws1");

    await store.markUsed("a1");
    expect((await store.getOwned("ws1", "a1"))?.lastUsedAt).toBeNumber();
    expect(await store.remove("ws2", "a1")).toBe(false);
    expect(await store.remove("ws1", "a1")).toBe(true);
    expect(await store.getOwned("ws1", "a1")).toBeNull();
  });
});
