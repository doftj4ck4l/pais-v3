import type { OAuthTokens } from "../../repositories/connector.repository";
import { buildAuthUrl } from "./google-oauth";

/**
 * Google Calendar, as far as this codebase is concerned.
 *
 * A sibling of `google-drive.ts`: it owns Calendar's URLs and scopes and calls
 * the REST API with the *user's* OAuth grant, so every request returns exactly
 * what that person can see and change in their own calendars. The shared OAuth
 * dance (consent, code exchange, refresh) lives in `google-oauth.ts`.
 *
 * Unlike Drive, this connector does not sync into the document index — it backs
 * live agent tools (`calendar-tools.ts`). Nothing here is called on a schedule.
 */

const CAL_API = "https://www.googleapis.com/calendar/v3";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * Read + write. `calendar.events` is the write grant for creating, updating and
 * deleting events; `calendar.readonly` and `calendar.calendarlist.readonly`
 * cover listing events and calendars; `userinfo.email` is only so the connector
 * can label which account it is — Drive gets the same from its own API, but
 * Calendar has no equivalent cheap "who am I" call.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** Where to send the browser to get consent, scoped to Calendar. */
export function authUrl(state: string): string {
  return buildAuthUrl(state, SCOPES);
}

async function calFetch(
  tokens: OAuthTokens,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${CAL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Calendar's error body carries the reason ("Not Found", "Invalid
    // timeMin") — surface it so the agent can correct its own arguments rather
    // than guess at a bare status code.
    throw new Error(
      `Calendar ${init?.method ?? "GET"} ${path.split("?")[0]} failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
    );
  }
  return res;
}

/** Which account a grant belongs to. Requires the `userinfo.email` scope. */
export async function accountEmail(tokens: OAuthTokens): Promise<string | null> {
  const res = await fetch(USERINFO, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { email?: string };
  return json.email ?? null;
}

// ---- shapes the tools work in, with Google's vocabulary kept minimal ----

export type CalendarSummary = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
};

export type EventTime = {
  /** RFC3339 timestamp for a timed event, e.g. 2026-08-20T14:00:00+08:00. */
  dateTime?: string;
  /** YYYY-MM-DD for an all-day event. */
  date?: string;
  timeZone?: string;
};

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: { email: string; responseStatus?: string }[];
  htmlLink?: string;
  hangoutLink?: string;
};

export type ListEventsOptions = {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  maxResults?: number;
};

export async function listCalendars(tokens: OAuthTokens): Promise<CalendarSummary[]> {
  const res = await calFetch(tokens, "/users/me/calendarList?fields=items(id,summary,primary,accessRole)");
  const json = (await res.json()) as {
    items?: { id: string; summary?: string; primary?: boolean; accessRole?: string }[];
  };
  return (json.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary ?? c.id,
    primary: Boolean(c.primary),
    accessRole: c.accessRole ?? "reader",
  }));
}

export async function listEvents(
  tokens: OAuthTokens,
  opts: ListEventsOptions = {},
): Promise<CalendarEvent[]> {
  const calendarId = opts.calendarId || "primary";
  const params = new URLSearchParams({
    // singleEvents + orderBy=startTime is the only way to get a chronological
    // list: without expansion, recurring events come back as one master row
    // with no concrete start time, and orderBy rejects the request.
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.max(1, Math.min(250, opts.maxResults ?? 25))),
  });
  if (opts.timeMin) params.set("timeMin", opts.timeMin);
  if (opts.timeMax) params.set("timeMax", opts.timeMax);
  if (opts.q) params.set("q", opts.q);
  const res = await calFetch(
    tokens,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
  );
  const json = (await res.json()) as { items?: CalendarEvent[] };
  return json.items ?? [];
}

export async function getEvent(
  tokens: OAuthTokens,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const res = await calFetch(
    tokens,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
  return (await res.json()) as CalendarEvent;
}

export type EventInput = {
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: { email: string }[];
};

export async function createEvent(
  tokens: OAuthTokens,
  calendarId: string,
  event: EventInput,
): Promise<CalendarEvent> {
  const res = await calFetch(
    tokens,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: "POST", body: JSON.stringify(event) },
  );
  return (await res.json()) as CalendarEvent;
}

export async function updateEvent(
  tokens: OAuthTokens,
  calendarId: string,
  eventId: string,
  patch: EventInput,
): Promise<CalendarEvent> {
  // PATCH, not PUT: the agent supplies only the fields it is changing, and a
  // PUT would blank every field it omitted.
  const res = await calFetch(
    tokens,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return (await res.json()) as CalendarEvent;
}

export async function deleteEvent(
  tokens: OAuthTokens,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await calFetch(
    tokens,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}

export type FreeBusySlot = { start: string; end: string };

export async function freeBusy(
  tokens: OAuthTokens,
  timeMin: string,
  timeMax: string,
  calendarIds: string[] = ["primary"],
): Promise<Record<string, FreeBusySlot[]>> {
  const res = await calFetch(tokens, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin, timeMax, items: calendarIds.map((id) => ({ id })) }),
  });
  const json = (await res.json()) as {
    calendars?: Record<string, { busy?: FreeBusySlot[] }>;
  };
  const out: Record<string, FreeBusySlot[]> = {};
  for (const [id, v] of Object.entries(json.calendars ?? {})) {
    out[id] = v.busy ?? [];
  }
  return out;
}
