import {
  connectorStore as defaultStore,
  type ConnectorStore,
  type OAuthTokens,
} from "../../repositories/connector.repository";
import { needsRefresh, refresh } from "./google-oauth";
import * as cal from "./google-calendar";
import type { CalendarEvent, EventInput, EventTime } from "./google-calendar";

/**
 * The agent's Google Calendar tools, bound to one workspace's connected account.
 *
 * These are live tools, not a sync: each call resolves the workspace's `gcal`
 * connector, refreshes its access token if it has aged out (persisting the new
 * one so the next call is cheap), and talks to the Calendar API as that user.
 * A workspace with no calendar connected gets no tools at all — `create` returns
 * an empty array — so the agent's tool list stays clean until someone opts in,
 * the same rule the MCP tools follow.
 *
 * The default timezone is GMT+8: this deployment is Malaysia-based (see the
 * `get_current_time` catalog tool), and Google requires *some* zone on a timed
 * event, so an unqualified time from the agent is interpreted locally rather
 * than silently landing in UTC an eight-hour walk away.
 */

const DEFAULT_TZ = "Asia/Kuala_Lumpur";

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: { output: string };
};

function text(out: string): ToolResult {
  return { content: [{ type: "text" as const, text: out }], details: { output: out } };
}

export type CalendarTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: any) => Promise<ToolResult>;
};

/**
 * Resolve the workspace's calendar account and a usable access token, or a
 * message explaining why there isn't one. Refreshes and persists on the way
 * through, so token ageing is invisible to every tool.
 */
async function activeTokens(
  workspaceId: string,
  store: ConnectorStore,
): Promise<{ ok: true; tokens: OAuthTokens } | { ok: false; message: string }> {
  const rows = await store.list(workspaceId);
  // First connected calendar account. Multiple accounts would need an
  // `account` argument on every tool; one is the common case and all this v1
  // supports — a second `gcal` row simply isn't reached.
  const conn = rows.find((r) => r.kind === "gcal");
  if (!conn) {
    return {
      ok: false,
      message:
        "Google Calendar is not connected for this workspace. Connect it under Settings → Connectors, then try again.",
    };
  }
  let tokens = await store.tokens(workspaceId, conn.id);
  if (!tokens) {
    return { ok: false, message: "Calendar credentials are unavailable — reconnect the account." };
  }
  if (needsRefresh(tokens)) {
    try {
      tokens = await refresh(tokens);
      await store.saveTokens(workspaceId, conn.id, tokens);
    } catch (e) {
      await store.markStatus(workspaceId, conn.id, "error", (e as Error).message);
      return {
        ok: false,
        message: `Could not refresh Google access — reconnect the account. (${(e as Error).message})`,
      };
    }
  }
  return { ok: true, tokens };
}

/** A time argument the agent may give as a plain timestamp or an all-day date. */
function toEventTime(value: unknown, timeZone: string): EventTime | undefined {
  const s = String(value ?? "").trim();
  if (!s) return undefined;
  // A bare date is an all-day marker; anything with a time is a timed event.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  return { dateTime: s, timeZone };
}

function fmtTime(t?: EventTime): string {
  if (!t) return "?";
  return t.dateTime ?? t.date ?? "?";
}

function fmtEvent(e: CalendarEvent): string {
  const parts = [`${fmtTime(e.start)} → ${fmtTime(e.end)}  ${e.summary ?? "(no title)"}`];
  const tail: string[] = [];
  if (e.location) tail.push(`@ ${e.location}`);
  if (e.attendees?.length) tail.push(`${e.attendees.length} guest(s)`);
  tail.push(`id=${e.id}`);
  parts.push(`    ${tail.join("  ·  ")}`);
  return parts.join("\n");
}

/** Every tool shares this: resolve tokens, then run, turning errors into text. */
function bind(
  workspaceId: string,
  store: ConnectorStore,
  fn: (tokens: OAuthTokens, params: any) => Promise<string>,
) {
  return async (_id: string, params: any): Promise<ToolResult> => {
    const auth = await activeTokens(workspaceId, store);
    if (!auth.ok) return text(auth.message);
    try {
      return text(await fn(auth.tokens, params ?? {}));
    } catch (e) {
      return text(`error: ${(e as Error).message}`);
    }
  };
}

export function createCalendarTools(
  workspaceId: string,
  store: ConnectorStore = defaultStore,
): CalendarTool[] {
  const calId = (params: any) => String(params?.calendarId ?? "primary").trim() || "primary";

  return [
    {
      name: "calendar_list_calendars",
      label: "calendar_list_calendars",
      description:
        "List the Google calendars this account can see, with their ids and access role. " +
        "Use a returned id as `calendarId` in the other calendar tools; the default is always the primary calendar.",
      parameters: { type: "object", properties: {} },
      execute: bind(workspaceId, store, async (tokens) => {
        const cals = await cal.listCalendars(tokens);
        if (!cals.length) return "no calendars found";
        return cals
          .map((c) => `${c.summary}${c.primary ? " (primary)" : ""}  [${c.accessRole}]  id=${c.id}`)
          .join("\n");
      }),
    },
    {
      name: "calendar_list_events",
      label: "calendar_list_events",
      description:
        "The user's Google Calendar — use this for what is on the user's calendar/schedule, in " +
        "preference to any other service's calendar (e.g. Nextcloud). Lists events in chronological " +
        "order. All arguments are optional: `timeMin`/`timeMax` are RFC3339 timestamps bounding the " +
        "window, `q` is a free-text search, `maxResults` caps the count (default 25). Recurring events " +
        "are expanded into individual occurrences.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "calendar id, default 'primary'" },
          timeMin: { type: "string", description: "RFC3339 lower bound, e.g. 2026-08-14T00:00:00+08:00" },
          timeMax: { type: "string", description: "RFC3339 upper bound" },
          q: { type: "string", description: "free-text search over event fields" },
          maxResults: { type: "integer", description: "max events, at most 250" },
        },
      },
      execute: bind(workspaceId, store, async (tokens, params) => {
        const events = await cal.listEvents(tokens, {
          calendarId: calId(params),
          timeMin: params?.timeMin ? String(params.timeMin) : undefined,
          timeMax: params?.timeMax ? String(params.timeMax) : undefined,
          q: params?.q ? String(params.q) : undefined,
          maxResults: params?.maxResults != null ? Number(params.maxResults) : undefined,
        });
        if (!events.length) return "no events in that range";
        return events.map(fmtEvent).join("\n");
      }),
    },
    {
      name: "calendar_get_event",
      label: "calendar_get_event",
      description: "Fetch one event's full details by id.",
      parameters: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "the event id" },
          calendarId: { type: "string", description: "calendar id, default 'primary'" },
        },
        required: ["eventId"],
      },
      execute: bind(workspaceId, store, async (tokens, params) => {
        const eventId = String(params?.eventId ?? "").trim();
        if (!eventId) return "error: eventId required";
        const e = await cal.getEvent(tokens, calId(params), eventId);
        const lines = [
          `title: ${e.summary ?? "(no title)"}`,
          `when: ${fmtTime(e.start)} → ${fmtTime(e.end)}`,
          e.location ? `where: ${e.location}` : null,
          e.description ? `description: ${e.description}` : null,
          e.attendees?.length
            ? `guests: ${e.attendees.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`).join(", ")}`
            : null,
          e.htmlLink ? `link: ${e.htmlLink}` : null,
          `id: ${e.id}`,
        ].filter(Boolean);
        return lines.join("\n");
      }),
    },
    {
      name: "calendar_create_event",
      label: "calendar_create_event",
      description:
        "Create an event. `start` and `end` are RFC3339 timestamps (e.g. 2026-08-20T14:00:00+08:00) " +
        "for a timed event, or plain YYYY-MM-DD dates for an all-day event. Times without an offset are " +
        `interpreted as ${DEFAULT_TZ} (GMT+8). Optional: description, location, attendees (a list of emails).`,
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "event title" },
          start: { type: "string", description: "RFC3339 timestamp or YYYY-MM-DD" },
          end: { type: "string", description: "RFC3339 timestamp or YYYY-MM-DD" },
          description: { type: "string" },
          location: { type: "string" },
          attendees: { type: "array", items: { type: "string" }, description: "guest email addresses" },
          timeZone: { type: "string", description: `IANA zone, default ${DEFAULT_TZ}` },
          calendarId: { type: "string", description: "calendar id, default 'primary'" },
        },
        required: ["summary", "start", "end"],
      },
      execute: bind(workspaceId, store, async (tokens, params) => {
        const summary = String(params?.summary ?? "").trim();
        if (!summary) return "error: summary required";
        const tz = String(params?.timeZone ?? DEFAULT_TZ).trim() || DEFAULT_TZ;
        const start = toEventTime(params?.start, tz);
        const end = toEventTime(params?.end, tz);
        if (!start || !end) return "error: both start and end are required";
        const event: EventInput = {
          summary,
          start,
          end,
          description: params?.description ? String(params.description) : undefined,
          location: params?.location ? String(params.location) : undefined,
          attendees: Array.isArray(params?.attendees)
            ? params.attendees.map((e: unknown) => ({ email: String(e) }))
            : undefined,
        };
        const created = await cal.createEvent(tokens, calId(params), event);
        return `created: ${created.summary ?? summary}\n${fmtTime(created.start)} → ${fmtTime(created.end)}\nid: ${created.id}${created.htmlLink ? `\nlink: ${created.htmlLink}` : ""}`;
      }),
    },
    {
      name: "calendar_update_event",
      label: "calendar_update_event",
      description:
        "Change fields on an existing event by id. Only the fields you pass are changed; omitted fields " +
        "are left as they are. `start`/`end` accept the same formats as create.",
      parameters: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "the event id" },
          summary: { type: "string" },
          start: { type: "string", description: "RFC3339 timestamp or YYYY-MM-DD" },
          end: { type: "string", description: "RFC3339 timestamp or YYYY-MM-DD" },
          description: { type: "string" },
          location: { type: "string" },
          attendees: { type: "array", items: { type: "string" }, description: "replaces the full guest list" },
          timeZone: { type: "string", description: `IANA zone, default ${DEFAULT_TZ}` },
          calendarId: { type: "string", description: "calendar id, default 'primary'" },
        },
        required: ["eventId"],
      },
      execute: bind(workspaceId, store, async (tokens, params) => {
        const eventId = String(params?.eventId ?? "").trim();
        if (!eventId) return "error: eventId required";
        const tz = String(params?.timeZone ?? DEFAULT_TZ).trim() || DEFAULT_TZ;
        const patch: EventInput = {};
        if (params?.summary != null) patch.summary = String(params.summary);
        if (params?.description != null) patch.description = String(params.description);
        if (params?.location != null) patch.location = String(params.location);
        if (params?.start != null) patch.start = toEventTime(params.start, tz);
        if (params?.end != null) patch.end = toEventTime(params.end, tz);
        if (Array.isArray(params?.attendees)) {
          patch.attendees = params.attendees.map((e: unknown) => ({ email: String(e) }));
        }
        if (Object.keys(patch).length === 0) return "error: nothing to update — pass at least one field";
        const updated = await cal.updateEvent(tokens, calId(params), eventId, patch);
        return `updated: ${updated.summary ?? "(no title)"}\n${fmtTime(updated.start)} → ${fmtTime(updated.end)}\nid: ${updated.id}`;
      }),
    },
    {
      name: "calendar_delete_event",
      label: "calendar_delete_event",
      description: "Delete an event by id. This cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "the event id" },
          calendarId: { type: "string", description: "calendar id, default 'primary'" },
        },
        required: ["eventId"],
      },
      execute: bind(workspaceId, store, async (tokens, params) => {
        const eventId = String(params?.eventId ?? "").trim();
        if (!eventId) return "error: eventId required";
        await cal.deleteEvent(tokens, calId(params), eventId);
        return `deleted event ${eventId}`;
      }),
    },
    {
      name: "calendar_freebusy",
      label: "calendar_freebusy",
      description:
        "Return the busy time blocks in a window, for checking availability before proposing a meeting. " +
        "`timeMin` and `timeMax` are RFC3339 timestamps; `calendarIds` defaults to the primary calendar.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "RFC3339 lower bound" },
          timeMax: { type: "string", description: "RFC3339 upper bound" },
          calendarIds: { type: "array", items: { type: "string" }, description: "calendar ids to check" },
        },
        required: ["timeMin", "timeMax"],
      },
      execute: bind(workspaceId, store, async (tokens, params) => {
        const timeMin = String(params?.timeMin ?? "").trim();
        const timeMax = String(params?.timeMax ?? "").trim();
        if (!timeMin || !timeMax) return "error: timeMin and timeMax are required";
        const ids = Array.isArray(params?.calendarIds) && params.calendarIds.length
          ? params.calendarIds.map((c: unknown) => String(c))
          : ["primary"];
        const busy = await cal.freeBusy(tokens, timeMin, timeMax, ids);
        const lines: string[] = [];
        for (const [id, slots] of Object.entries(busy)) {
          if (!slots.length) {
            lines.push(`${id}: free`);
          } else {
            lines.push(`${id}: busy`);
            for (const s of slots) lines.push(`    ${s.start} → ${s.end}`);
          }
        }
        return lines.join("\n") || "no calendars checked";
      }),
    },
  ];
}
