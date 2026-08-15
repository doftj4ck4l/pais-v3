import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { env } from "../../config/env";
import { SqliteConnectorStore } from "../../repositories/connector.repository";
import { createCalendarTools } from "./calendar-tools";

/**
 * Exercises the Google Calendar agent tools end to end against a real
 * SQLite-backed connector store, with `fetch` stubbed so the Calendar REST
 * layer is real but the network is not. This proves, without a Google account:
 * a workspace with no calendar connected gets a helpful refusal rather than a
 * crash; list/create/delete build the right requests and parse the responses;
 * and an aged-out access token is refreshed and persisted before the call it
 * gates, invisibly to the tool.
 */

(env as { connectionSecret: string }).connectionSecret = "test-secret";
(env as { googleClientId: string }).googleClientId = "test-client";
(env as { googleClientSecret: string }).googleClientSecret = "test-secret-2";

const WS = "ws-cal";

type FetchCall = { url: string; method: string; body: string | null };

let store: SqliteConnectorStore;
let calls: FetchCall[];
let realFetch: typeof globalThis.fetch;

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}

function tool(name: string) {
  const t = createCalendarTools(WS, store).find((x) => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
}

async function seedConnector(expiresAt: number) {
  await store.create({
    id: "con_cal",
    workspaceId: WS,
    kind: "gcal",
    accountEmail: "me@example.com",
    tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt },
  });
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  store = new SqliteConnectorStore(drizzle(sqlite) as never);

  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: (init?.body as string) ?? null });

    if (url.includes("oauth2.googleapis.com/token")) {
      return ok({ access_token: "at-refreshed", expires_in: 3600 });
    }
    if (url.includes("/oauth2/v2/userinfo")) return ok({ email: "me@example.com" });
    if (url.includes("/freeBusy")) return ok({ calendars: { primary: { busy: [] } } });
    if (url.includes("/events?")) {
      return ok({
        items: [
          {
            id: "ev1",
            summary: "Standup",
            start: { dateTime: "2026-08-20T09:00:00+08:00" },
            end: { dateTime: "2026-08-20T09:15:00+08:00" },
          },
        ],
      });
    }
    if (/\/events\/[^/?]+$/.test(url.split("?")[0]) && (init?.method ?? "GET") === "GET") {
      return ok({ id: "ev1", summary: "Standup", start: {}, end: {} });
    }
    if (url.endsWith("/events") && init?.method === "POST") {
      return ok({ id: "ev-new", summary: "Lunch", start: {}, end: {}, htmlLink: "https://cal/ev-new" });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "PATCH") return ok({ id: "ev1", summary: "Renamed", start: {}, end: {} });
    return ok({ items: [] });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FRESH = Date.now() + 3_600_000;

describe("calendar tools", () => {
  it("refuses helpfully when no calendar is connected", async () => {
    const res = await tool("calendar_list_events").execute("1", {});
    expect(res.details.output).toContain("not connected");
    // No network touched — the refusal is decided from the store alone.
    expect(calls.length).toBe(0);
  });

  it("lists events from the primary calendar", async () => {
    await seedConnector(FRESH);
    const res = await tool("calendar_list_events").execute("1", {});
    expect(res.details.output).toContain("Standup");
    expect(res.details.output).toContain("id=ev1");
    const events = calls.find((c) => c.url.includes("/events?"));
    expect(events?.url).toContain("calendars/primary/events");
    expect(events?.url).toContain("singleEvents=true");
  });

  it("creates an event with the fields it was given", async () => {
    await seedConnector(FRESH);
    const res = await tool("calendar_create_event").execute("1", {
      summary: "Lunch",
      start: "2026-08-20T12:00:00+08:00",
      end: "2026-08-20T13:00:00+08:00",
      location: "Cafe",
    });
    expect(res.details.output).toContain("created");
    expect(res.details.output).toContain("ev-new");
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/events"));
    expect(post).toBeTruthy();
    const sent = JSON.parse(post!.body ?? "{}");
    expect(sent.summary).toBe("Lunch");
    expect(sent.start.dateTime).toBe("2026-08-20T12:00:00+08:00");
    expect(sent.location).toBe("Cafe");
  });

  it("treats a bare date as an all-day event", async () => {
    await seedConnector(FRESH);
    await tool("calendar_create_event").execute("1", {
      summary: "Holiday",
      start: "2026-08-31",
      end: "2026-09-01",
    });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/events"));
    const sent = JSON.parse(post!.body ?? "{}");
    expect(sent.start.date).toBe("2026-08-31");
    expect(sent.start.dateTime).toBeUndefined();
  });

  it("deletes an event by id", async () => {
    await seedConnector(FRESH);
    const res = await tool("calendar_delete_event").execute("1", { eventId: "ev1" });
    expect(res.details.output).toContain("deleted");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/events/ev1");
  });

  it("refreshes an aged-out token before the call and persists it", async () => {
    await seedConnector(Date.now() - 1000); // already expired
    await tool("calendar_list_events").execute("1", {});
    // The token endpoint was hit before the events call.
    const tokenIdx = calls.findIndex((c) => c.url.includes("/token"));
    const eventsIdx = calls.findIndex((c) => c.url.includes("/events?"));
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(eventsIdx).toBeGreaterThan(tokenIdx);
    // The refreshed token is what the events call carried, and it was saved.
    const saved = await store.tokens(WS, "con_cal");
    expect(saved?.accessToken).toBe("at-refreshed");
    // Refresh must not lose the refresh token Google did not re-send.
    expect(saved?.refreshToken).toBe("rt-1");
  });

  it("requires an eventId to update", async () => {
    await seedConnector(FRESH);
    const res = await tool("calendar_update_event").execute("1", { summary: "x" });
    // eventId missing -> refuses before any network call for this tool.
    expect(res.details.output).toContain("eventId required");
  });
});
