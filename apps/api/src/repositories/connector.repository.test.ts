import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { env } from "../config/env";
import { SqliteConnectorStore, type OAuthTokens } from "./connector.repository";

(env as { connectionSecret: string }).connectionSecret = "test-secret";

let sqlite: Database;
let store: SqliteConnectorStore;

const tokens: OAuthTokens = {
  accessToken: "ya29.super-secret",
  refreshToken: "1//refresh-secret",
  expiresAt: 1_800_000_000_000,
};

beforeEach(async () => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  store = new SqliteConnectorStore(drizzle(sqlite) as never);
  await store.create({
    id: "con1",
    workspaceId: "ws1",
    kind: "gdrive",
    accountEmail: "a@example.com",
    tokens,
  });
});

describe("connector secrets", () => {
  it("never returns tokens from a list or a get", async () => {
    // The reason these are selected by explicit column list: a field added to
    // the table later must not start appearing in API responses for free.
    const [row] = await store.list("ws1");
    expect(JSON.stringify(row)).not.toContain("super-secret");
    expect(JSON.stringify(row)).not.toContain("refresh-secret");
    expect(row).not.toHaveProperty("tokensEnc");

    const one = await store.get("ws1", "con1");
    expect(JSON.stringify(one)).not.toContain("secret");
  });

  it("stores the tokens encrypted, not as readable JSON", async () => {
    const raw = sqlite.query("select tokens_enc from connectors where id = 'con1'").get() as {
      tokens_enc: string;
    };
    expect(raw.tokens_enc).not.toContain("super-secret");
    expect(raw.tokens_enc).not.toContain("accessToken");
  });

  it("round-trips them through the one method meant to read them", async () => {
    expect(await store.tokens("ws1", "con1")).toEqual(tokens);
  });

  it("reports an undecryptable row as no credentials rather than throwing", async () => {
    // What a changed CONNECTION_SECRET looks like. The connector should read as
    // "reconnect", not take the request down.
    sqlite.query("update connectors set tokens_enc = 'garbage' where id = 'con1'").run();
    expect(await store.tokens("ws1", "con1")).toBeNull();
  });
});

describe("connector scoping", () => {
  it("does not read another workspace's connector", async () => {
    expect(await store.get("ws2", "con1")).toBeNull();
    expect(await store.tokens("ws2", "con1")).toBeNull();
    expect(await store.list("ws2")).toHaveLength(0);
  });

  it("does not remove another workspace's connector", async () => {
    expect(await store.remove("ws2", "con1")).toBe(false);
    expect(await store.list("ws1")).toHaveLength(1);
  });

  it("finds an existing connector by account so re-auth replaces it", async () => {
    // Two connectors for one Drive would sync every file twice.
    const found = await store.findByAccount("ws1", "gdrive", "a@example.com");
    expect(found?.id).toBe("con1");
    expect(await store.findByAccount("ws1", "gdrive", "other@example.com")).toBeNull();
    expect(await store.findByAccount("ws2", "gdrive", "a@example.com")).toBeNull();
  });
});

describe("connector state", () => {
  it("stamps lastSyncAt on a terminal status but not while syncing", async () => {
    await store.markStatus("ws1", "con1", "syncing", null);
    expect((await store.get("ws1", "con1"))!.lastSyncAt).toBeNull();

    await store.markStatus("ws1", "con1", "error", "HTTP 403");
    const row = (await store.get("ws1", "con1"))!;
    expect(row.status).toBe("error");
    expect(row.error).toBe("HTTP 403");
    // Stamped even though it failed: "never ran" and "failed an hour ago" are
    // different problems.
    expect(row.lastSyncAt).toBeGreaterThan(0);
  });

  it("keeps the cursor across syncs", async () => {
    await store.saveCursor("ws1", "con1", "page-token-9");
    expect((await store.get("ws1", "con1"))!.cursor).toBe("page-token-9");
  });

  it("replaces tokens on re-authorisation", async () => {
    const next: OAuthTokens = { accessToken: "new", refreshToken: "rt2", expiresAt: 1 };
    await store.saveTokens("ws1", "con1", next);
    expect(await store.tokens("ws1", "con1")).toEqual(next);
  });
});
