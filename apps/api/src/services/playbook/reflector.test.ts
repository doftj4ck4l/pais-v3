import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqlitePlaybookStore } from "../../repositories/playbook.repository";
import type { ModelConfig } from "../../catalog/llm-models";
import type { AssistantChunk } from "../../types/chat";
import { reflect } from "./reflector";

const model = { id: "test", provider: "mock", model: "m" } as ModelConfig;

let sqlite: Database;
let store: SqlitePlaybookStore;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  store = new SqlitePlaybookStore(drizzle(sqlite) as never);
});

/** A stubbed provider that answers with `text`, and records what it was asked. */
function stubChat(text: string) {
  const seen: string[] = [];
  const chat = async (_m: ModelConfig, messages: any[]): Promise<AssistantChunk> => {
    seen.push(messages.map((msg) => msg.content).join("\n"));
    return { text, toolCalls: [] } as unknown as AssistantChunk;
  };
  return { chat, seen };
}

const input = (over: Partial<Parameters<typeof reflect>[0]> = {}) => ({
  workspaceId: "ws1",
  runId: "run1",
  model,
  history: [{ role: "user" as const, content: "create a task in pixel" }],
  answer: "Done, created PIXEL-5.",
  toolCalls: [
    { name: "plane__create_work_item", ok: true, args: '{"name":"Sample"}', resultChars: 200 },
  ],
  ...over,
});

describe("reflect", () => {
  it("writes what the run learned", async () => {
    const { chat } = stubChat(
      '[{"op":"add","kind":"route","content":"Create a Plane task with plane__create_work_item."}]',
    );

    const outcome = await reflect(input(), store, chat as never);

    expect(outcome.added).toBe(1);
    const bullets = await store.list("ws1");
    expect(bullets[0]!.content).toContain("plane__create_work_item");
    expect(bullets[0]!.kind).toBe("route");
  });

  it("shows the reflector the existing playbook, with ids", async () => {
    await store.apply("ws1", "run0", [{ op: "add", kind: "fact", content: "Plane is at X" }]);
    const id = (await store.list("ws1"))[0]!.id;
    const { chat, seen } = stubChat("[]");

    await reflect(input(), store, chat as never);

    expect(seen[0]).toContain(id);
    expect(seen[0]).toContain("Plane is at X");
  });

  it("tells the reflector when a run was hunting for a tool", async () => {
    const { chat, seen } = stubChat("[]");

    await reflect(
      input({
        toolCalls: [
          { name: "search_tools", ok: true, args: "1", resultChars: 50 },
          { name: "search_tools", ok: true, args: "2", resultChars: 50 },
          { name: "search_tools", ok: true, args: "3", resultChars: 50 },
        ],
      }),
      store,
      chat as never,
    );

    expect(seen[0]).toContain("hunting");
    expect(seen[0]).toContain("pitfall");
  });

  it("writes nothing when the reflector returns an empty array", async () => {
    const { chat } = stubChat("[]");
    const outcome = await reflect(input(), store, chat as never);

    expect(outcome.added).toBe(0);
    expect(await store.list("ws1")).toHaveLength(0);
  });

  it("writes nothing when the reflector answers with prose", async () => {
    const { chat } = stubChat("I think the user wants a task created.");
    expect((await reflect(input(), store, chat as never)).added).toBe(0);
    expect(await store.list("ws1")).toHaveLength(0);
  });

  it("survives the reflection call failing", async () => {
    // A run that answered correctly must not be reported as failed because the
    // thing that learns from it did not.
    const chat = async () => {
      throw new Error("gateway 502");
    };
    const outcome = await reflect(input(), store, chat as never);
    expect(outcome.added).toBe(0);
    expect(outcome.deltas).toEqual([]);
  });

  it("does not call the model for a run that did nothing", async () => {
    const { chat, seen } = stubChat("[]");
    await reflect(input({ toolCalls: [], answer: "  " }), store, chat as never);
    expect(seen).toHaveLength(0);
  });

  it("cannot be made to delete the playbook", async () => {
    // There is no operation that removes a bullet or replaces the document, so
    // a reflector that asks for one changes nothing. This is the failure mode
    // that turns an evolving context into an empty one.
    await store.apply("ws1", "run0", [{ op: "add", kind: "fact", content: "Hard-won knowledge" }]);
    const { chat } = stubChat(
      '[{"op":"remove","id":"pb_1"},{"op":"replace_all","content":"(nothing important)"}]',
    );

    await reflect(input(), store, chat as never);

    expect(await store.list("ws1")).toHaveLength(1);
  });

  it("ignores bullets attached to ids it invented", async () => {
    const { chat } = stubChat('[{"op":"revise","id":"pb_nonexistent","content":"injected"}]');
    await reflect(input(), store, chat as never);
    expect(await store.list("ws1")).toHaveLength(0);
  });
});
