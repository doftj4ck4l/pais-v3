import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createHash } from "node:crypto";
import { MODELS } from "../../catalog/llm-models";
import { applySchema } from "../../db/client";
import { SqliteAgentStore } from "../../repositories/agent.repository";
import type { AssistantChunk } from "../../types/chat";
import {
  AgentInputError,
  AgentNotFoundError,
  AgentService,
  InvalidAgentTokenError,
} from "./agent.service";

let sqlite: Database;
let store: SqliteAgentStore;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  applySchema(sqlite);
  sqlite.run("INSERT INTO users (id, created_at) VALUES ('u-1', 1), ('u-2', 1)");
  sqlite.run(
    "INSERT INTO workspaces (id, user_id, name, created_at) VALUES ('ws-1', 'u-1', 'One', 1), ('ws-2', 'u-2', 'Two', 1)",
  );
  store = new SqliteAgentStore(drizzle(sqlite) as never);
});

afterEach(() => sqlite.close());

const modelId = MODELS[0]!.id;

const answer = (text = "Hello from the agent"): AssistantChunk => ({
  text,
  reasoningContent: "",
  toolCalls: [],
});

describe("agent service", () => {
  it("creates an agent and returns its secret only once", async () => {
    const service = new AgentService(store, async () => answer());

    const created = await service.create("ws-1", {
      name: "  Support guide  ",
      systemPrompt: "  Answer with concise steps.  ",
      modelId,
    });

    expect(created.agent.name).toBe("Support guide");
    expect(created.agent.systemPrompt).toBe("Answer with concise steps.");
    expect(created.token).toStartWith("psa_");
    expect(created.agent.tokenHint).toBe(created.token.slice(-4));
    expect((await store.getOwned("ws-1", created.agent.id))?.tokenDigest).toBe(
      createHash("sha256").update(created.token, "utf8").digest("hex"),
    );
    expect(JSON.stringify(created.agent)).not.toContain(created.token);
    expect(await service.list("ws-1")).toEqual([created.agent]);
  });

  it("rejects invalid definitions before storing them", async () => {
    const service = new AgentService(store, async () => answer());

    await expect(
      service.create("ws-1", { name: "", systemPrompt: "Help", modelId }),
    ).rejects.toBeInstanceOf(AgentInputError);
    await expect(
      service.create("ws-1", { name: "Helper", systemPrompt: "Help", modelId: "missing" }),
    ).rejects.toThrow("Unknown model");
    await expect(service.create("ws-1", null)).rejects.toBeInstanceOf(AgentInputError);
    expect(await store.list("ws-1")).toHaveLength(0);
  });

  it("invokes the configured model with the custom prompt and no tools", async () => {
    const calls: unknown[][] = [];
    const service = new AgentService(store, async (...args) => {
      calls.push(args);
      return answer();
    });
    const { token, agent } = await service.create("ws-1", {
      name: "Travel guide",
      systemPrompt: "Be practical.",
      modelId,
    });

    const result = await service.invoke(token, {
      message: "What should I pack?",
      history: [
        { role: "user", content: "I am visiting Penang." },
        { role: "assistant", content: "What month?" },
      ],
    });

    expect(result).toMatchObject({
      agentId: agent.id,
      agentName: "Travel guide",
      modelId,
      reply: "Hello from the agent",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual([
      { role: "system", content: "Be practical." },
      { role: "user", content: "I am visiting Penang." },
      { role: "assistant", content: "What month?" },
      { role: "user", content: "What should I pack?" },
    ]);
    expect(calls[0]![2]).toEqual([]);
    expect((await store.getOwned("ws-1", agent.id))?.lastUsedAt).not.toBeNull();
  });

  it("runs a persisted retired model id through the active Pixel Pro replacement", async () => {
    let invokedModelId: string | undefined;
    const service = new AgentService(store, async (model) => {
      invokedModelId = model.id;
      return answer();
    });
    const { token } = await service.create("ws-1", {
      name: "Existing agent",
      systemPrompt: "Keep working after the catalog changes.",
      modelId: "gw-qwen3.6-35b",
    });

    await expect(service.invoke(token, { message: "Hello" })).resolves.toMatchObject({
      modelId: "gw-qwen3.6-35b",
      reply: "Hello from the agent",
    });
    expect(invokedModelId).toBe("pixel-pro-1");
  });

  it("distinguishes invalid public keys from unavailable managed agents", async () => {
    const service = new AgentService(store, async () => answer());
    const { agent } = await service.create("ws-1", {
      name: "Private",
      systemPrompt: "Keep it private.",
      modelId,
    });

    await expect(service.invoke("psa_not-real", { message: "Hello" })).rejects.toBeInstanceOf(
      InvalidAgentTokenError,
    );
    await expect(service.preview("ws-2", agent.id, { message: "Hello" })).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it("aborts public provider calls at the configured timeout without timing out previews", async () => {
    let publicSignal: AbortSignal | undefined;
    let previewSignal: AbortSignal | undefined;
    let call = 0;
    const service = new AgentService(
      store,
      (_model, _messages, _tools, signal) => {
        call += 1;
        if (call === 2) {
          previewSignal = signal;
          return Promise.resolve(answer("Preview"));
        }
        publicSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      5,
    );
    const { token, agent } = await service.create("ws-1", {
      name: "Bounded",
      systemPrompt: "Answer.",
      modelId,
    });

    await expect(service.invoke(token, { message: "Hello" })).rejects.toThrow();
    expect(publicSignal?.aborted).toBe(true);
    expect(await service.preview("ws-1", agent.id, { message: "Hello" })).toMatchObject({
      reply: "Preview",
    });
    expect(previewSignal).toBeUndefined();
  });

  it("treats an empty provider response as a failed invocation", async () => {
    const service = new AgentService(store, async () => answer(""));
    const { token } = await service.create("ws-1", {
      name: "Quiet",
      systemPrompt: "Answer.",
      modelId,
    });

    await expect(service.invoke(token, { message: "Hello" })).rejects.toThrow(
      "finished without producing an answer",
    );
  });

  it("reports null invocation bodies as input errors", async () => {
    const service = new AgentService(store, async () => answer());
    const { token } = await service.create("ws-1", {
      name: "Strict",
      systemPrompt: "Answer.",
      modelId,
    });

    await expect(service.invoke(token, null)).rejects.toBeInstanceOf(AgentInputError);
  });
});
