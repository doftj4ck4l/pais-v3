import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which chat a file came from, over the real messages table.
 *
 * The parsing is the whole risk here: every path it reads was written by a
 * model into a tool argument, so the shapes are whatever the model produced —
 * absolute or relative, a workspace that is not this one, a `read` that touched
 * a file without creating it.
 *
 * A throwaway database because these write, and because the singleton the
 * repository uses cannot be injected.
 */
let dir: string;
let fileOrigins: typeof import("./file-origins").fileOrigins;
let conversationRepository: typeof import("../../repositories/conversation.repository").conversationRepository;

/** One tool call, stored the way `persist` stores it. */
const toolMessage = (call: { name: string; args?: unknown; result?: string }) => ({
  kind: "tool",
  text: JSON.stringify(call),
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-origins-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  const { ensureSchema } = await import("../../db/client");
  await ensureSchema();
  ({ fileOrigins } = await import("./file-origins"));
  ({ conversationRepository } = await import("../../repositories/conversation.repository"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A conversation whose transcript is the given tool calls, in order. */
async function chat(
  workspaceId: string,
  title: string,
  calls: { name: string; args?: unknown; result?: string }[],
) {
  const id = await conversationRepository.create({ workspaceId, title, modelId: "m", harnessId: "pi" });
  await conversationRepository.appendMessages(
    id,
    calls.map((call, seq) => ({ ...toolMessage(call), seq })),
  );
  return id;
}

describe("fileOrigins", () => {
  it("credits the chat whose write named the file", async () => {
    const id = await chat("ws_origins_a", "Make the report", [
      { name: "write", args: { path: "report.md" } },
    ]);

    const origins = await fileOrigins("ws_origins_a");
    expect(origins.get("report.md")).toEqual({ conversationId: id, title: "Make the report" });
  });

  it("strips the sandbox directory the model was given", async () => {
    await chat("ws_origins_b", "Absolute path", [
      { name: "write", args: { path: "/home/dev/pixelspace-workspaces/ws_origins_b/out/data.csv" } },
    ]);

    expect((await fileOrigins("ws_origins_b")).get("out/data.csv")?.title).toBe("Absolute path");
  });

  it("reads share_file's own download URL, percent-encoding and all", async () => {
    await chat("ws_origins_c", "Share it", [
      {
        name: "share_file",
        args: { path: "unreadable" },
        result: "Shared. Download at /api/workspace/files/sub%20dir/q3.xlsx?workspaceId=ws_origins_c —",
      },
    ]);

    expect((await fileOrigins("ws_origins_c")).get("sub dir/q3.xlsx")?.title).toBe("Share it");
  });

  it("claims nothing for a file that was only read, or written outside a workspace", async () => {
    await chat("ws_origins_d", "Just looking", [
      { name: "read", args: { path: "existing.md" } },
      { name: "write", args: { path: "/etc/passwd" } },
    ]);

    const origins = await fileOrigins("ws_origins_d");
    expect(origins.has("existing.md")).toBe(false);
    expect(origins.size).toBe(0);
  });

  it("gives a file two chats have written to the most recent one", async () => {
    await chat("ws_origins_e", "First draft", [{ name: "write", args: { path: "notes.md" } }]);
    // `appendMessages` stamps a batch with one `Date.now()`, so two chats
    // written in the same millisecond have no order to compare.
    await Bun.sleep(5);
    const second = await chat("ws_origins_e", "Second pass", [
      { name: "edit", args: { path: "notes.md" } },
    ]);

    expect((await fileOrigins("ws_origins_e")).get("notes.md")).toEqual({
      conversationId: second,
      title: "Second pass",
    });
  });

  it("does not look into another workspace's transcripts", async () => {
    await chat("ws_origins_f", "Elsewhere", [{ name: "write", args: { path: "secret.md" } }]);

    expect((await fileOrigins("ws_origins_g")).size).toBe(0);
  });
});
