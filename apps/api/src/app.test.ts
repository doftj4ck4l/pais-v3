import { beforeAll, describe, expect, it } from "bun:test";
import { CHAT_ONLY_SYSTEM_PROMPT } from "./services/agent/model-runtime-policy";

/**
 * These assert the wiring, not the middleware itself: that tenant-scoped
 * routes are behind auth and that the one route the container healthcheck
 * calls is not.
 *
 * The schema is applied first even though nothing here is about storage:
 * `/api/me` reads the display name, so it needs tables. Without this the file
 * passes on a machine whose working database happens to be migrated and fails
 * on a fresh checkout, which is what CI is every time.
 */
let createApp: typeof import("./app").createApp;

beforeAll(async () => {
  // DB_PATH is already a throwaway under `bun test`; this fills it in.
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));
});
describe("api auth wiring", () => {
  it("refuses a tenant-scoped route with no identity", async () => {
    const res = await createApp().request("/api/workspaces");

    expect(res.status).toBe(401);
  });

  it("leaves /api/meta open for the container healthcheck", async () => {
    const res = await createApp().request("/api/meta");

    expect(res.status).toBe(200);
  });

  it("leaves agent invocation open for bearer-key callers", async () => {
    const res = await createApp().request("/api/agents/invoke", {
      method: "POST",
      headers: {
        authorization: "Bearer psa_not-real",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Agent not found or API key is invalid" });
  });

  it("keeps agent management behind the signed-in identity", async () => {
    const res = await createApp().request("/api/agents");

    expect(res.status).toBe(401);
  });
});

describe("POST /api/agents/invoke", () => {
  it("requires a bearer key", async () => {
    const res = await createApp().request("/api/agents/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "A Bearer agent API key is required" });
  });

  it("requires JSON so a browser cannot submit a secret-bearing simple request", async () => {
    const res = await createApp().request("/api/agents/invoke", {
      method: "POST",
      headers: { authorization: "Bearer psa_not-real" },
      body: "message=Hello",
    });

    expect(res.status).toBe(415);
  });

  it("authenticates the key before reading the request and caps authenticated bodies", async () => {
    const oversizedBody = JSON.stringify({ message: "x".repeat(100_000) });
    const invalid = await createApp().request("/api/agents/invoke", {
      method: "POST",
      headers: {
        authorization: "Bearer psa_not-real",
        "content-type": "application/json",
      },
      body: oversizedBody,
    });
    expect(invalid.status).toBe(401);

    const managementHeaders = {
      "content-type": "application/json",
      "x-authentik-uid": "agent-body-limit-user",
    };
    const meta = (await (await createApp().request("/api/meta")).json()) as {
      models: { id: string }[];
    };
    const created = await createApp().request("/api/agents", {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({
        name: "Body limit helper",
        systemPrompt: "Answer clearly.",
        modelId: meta.models[0]!.id,
      }),
    });
    const { token } = (await created.json()) as { token: string };
    const oversized = await createApp().request("/api/agents/invoke", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: oversizedBody,
    });

    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "Request body is too large" });
  });
});

describe("agent management", () => {
  it("creates and lists an agent without returning the stored token digest", async () => {
    const headers = {
      "content-type": "application/json",
      "x-authentik-uid": "agent-builder-user",
    };
    const meta = (await (await createApp().request("/api/meta")).json()) as {
      models: { id: string }[];
    };
    const modelId = meta.models[0]!.id;
    const created = await createApp().request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Mobile helper",
        systemPrompt: "Answer clearly.",
        modelId,
      }),
    });

    expect(created.status).toBe(201);
    const payload = (await created.json()) as {
      agent: Record<string, unknown>;
      token: string;
    };
    expect(payload.token).toStartWith("psa_");
    expect(payload.agent.endpoint).toBe("/api/agents/invoke");
    expect(payload.agent.tokenDigest).toBeUndefined();

    const listed = await createApp().request("/api/agents", { headers });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { agents: Record<string, unknown>[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.tokenDigest).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(payload.token);
  });

  it("returns not found when previewing an agent outside the selected workspace", async () => {
    const ownerHeaders = {
      "content-type": "application/json",
      "x-authentik-uid": "agent-preview-owner",
    };
    const meta = (await (await createApp().request("/api/meta")).json()) as {
      models: { id: string }[];
    };
    const created = await createApp().request("/api/agents", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        name: "Private preview",
        systemPrompt: "Answer clearly.",
        modelId: meta.models[0]!.id,
      }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    const preview = await createApp().request(`/api/agents/${agent.id}/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-authentik-uid": "agent-preview-outsider",
      },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(preview.status).toBe(404);
    expect(await preview.json()).toEqual({ error: "Agent not found" });
  });
});

describe("GET /api/me", () => {
  it("reports the authenticated identity", async () => {
    const res = await createApp().request("/api/me", {
      headers: {
        "x-authentik-uid": "alice-uid",
        "x-authentik-username": "alice",
        "x-authentik-email": "alice@example.com",
        "x-authentik-groups": "engineering|admins",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "alice-uid",
      username: "alice",
      email: "alice@example.com",
      groups: ["engineering", "admins"],
    });
  });

  it("is itself behind auth", async () => {
    const res = await createApp().request("/api/me");

    expect(res.status).toBe(401);
  });
});

describe("POST /api/chat", () => {
  it("rejects image attachments for a chat-only model", async () => {
    const res = await createApp().request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-authentik-uid": "alice-uid",
      },
      body: JSON.stringify({
        modelId: "local-qwen3.8-27b-uncensored",
        messages: [{ role: "user", content: "Describe this" }],
        imageIds: ["image-1"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("supports text chat only");
  });

  it("rejects prompt templates for a chat-only model", async () => {
    const res = await createApp().request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-authentik-uid": "alice-uid",
      },
      body: JSON.stringify({
        modelId: "local-qwen3.8-27b-uncensored",
        messages: [{ role: "user", content: "Run a template" }],
        template: { name: "research" },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("accepts plain text prompts only");
  });

  it("sends one plain provider request without agent resources", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push((await req.json()) as Record<string, unknown>);
        const chunk = {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "chat-only-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "CHAT_ONLY_OK" },
              finish_reason: null,
            },
          ],
        };
        const done = {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 24, completion_tokens: 3, total_tokens: 27 },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const res = await createApp().request("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-authentik-uid": "chat-only-user",
        },
        body: JSON.stringify({
          modelId: "local-qwen3.8-27b-uncensored",
          modelConfig: {
            baseUrl: `http://127.0.0.1:${provider.port}/v1`,
            model: "chat-only-test",
            apiKey: "test-key",
          },
          messages: [
            {
              role: "user",
              content:
                "Earlier question\n\n[The user attached an image to this message: /api/images/image-1. " +
                "You cannot see it directly — call read_image with that source and a specific " +
                "question to find out what it shows.]",
            },
            {
              role: "assistant",
              content: "Earlier answer",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "read_image", arguments: '{"source":"image-1"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "call-1", content: "image details" },
            { role: "user", content: "Reply with CHAT_ONLY_OK" },
          ],
          reasoningEffort: "low",
        }),
      });

      const stream = await res.text();
      await Bun.sleep(50);

      expect(stream).toContain('"tools":[]');
      expect(stream).not.toContain('"step":"sandbox.acquire"');
      expect(stream).not.toContain('"step":"mcp.catalog"');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.tools).toBeUndefined();
      expect(requests[0]?.messages).toEqual([
        { role: "system", content: CHAT_ONLY_SYSTEM_PROMPT },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: [{ type: "text", text: "Reply with CHAT_ONLY_OK" }] },
      ]);
    } finally {
      provider.stop(true);
    }
  });
});
