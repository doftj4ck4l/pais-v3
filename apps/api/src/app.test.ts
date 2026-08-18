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
