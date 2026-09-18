import { beforeAll, describe, expect, it } from "bun:test";

let createApp: typeof import("./app").createApp;
let workspaceRegistry: typeof import("./repositories/workspace-registry.repository").workspaceRegistry;
let conversationRepository: typeof import("./repositories/conversation.repository").conversationRepository;

beforeAll(async () => {
  const { ensureSchema } = await import("./db/client");
  ensureSchema();
  ({ createApp } = await import("./app"));
  ({ workspaceRegistry } = await import("./repositories/workspace-registry.repository"));
  ({ conversationRepository } = await import("./repositories/conversation.repository"));
});

async function fixture(userId: string) {
  const workspace = await workspaceRegistry.create(userId, `Pins ${userId}`);
  const conversationId = await conversationRepository.create({
    workspaceId: workspace.id,
    title: "Keep this chat",
    modelId: "test-model",
    harnessId: "general",
    status: "done",
  });
  return { workspaceId: workspace.id, conversationId };
}

const requestHeaders = (userId: string) => ({
  "x-authentik-uid": userId,
  "content-type": "application/json",
});

describe("PATCH /api/conversations/:id", () => {
  it("pins a conversation and returns it in subsequent lists", async () => {
    const app = createApp();
    const { workspaceId, conversationId } = await fixture("pin-owner");

    const updated = await app.request(
      `/api/conversations/${conversationId}?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: requestHeaders("pin-owner"),
        body: JSON.stringify({ pinned: true }),
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { conversation: { pinned: boolean } }).conversation.pinned).toBe(
      true,
    );

    const listed = await app.request(`/api/conversations?workspaceId=${workspaceId}`, {
      headers: requestHeaders("pin-owner"),
    });
    const body = (await listed.json()) as { conversations: { id: string; pinned: boolean }[] };
    expect(body.conversations.find((row) => row.id === conversationId)?.pinned).toBe(true);
  });

  it("does not let another workspace pin the conversation", async () => {
    const app = createApp();
    const owner = await fixture("pin-private-owner");
    const stranger = await workspaceRegistry.create("pin-stranger", "Stranger pins");

    const response = await app.request(
      `/api/conversations/${owner.conversationId}?workspaceId=${stranger.id}`,
      {
        method: "PATCH",
        headers: requestHeaders("pin-stranger"),
        body: JSON.stringify({ pinned: true }),
      },
    );

    expect(response.status).toBe(404);
    expect((await conversationRepository.get(owner.conversationId))?.pinned).toBe(false);
  });

  it("rejects anything other than an explicit boolean", async () => {
    const app = createApp();
    const { workspaceId, conversationId } = await fixture("pin-validation");

    const response = await app.request(
      `/api/conversations/${conversationId}?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: requestHeaders("pin-validation"),
        body: JSON.stringify({ pinned: "yes" }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "pinned must be a boolean" });
  });
});
