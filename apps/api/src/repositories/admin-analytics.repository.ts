import { sql } from "drizzle-orm";
import {
  conversations,
  db,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../db/client";

const DAY_MS = 86_400_000;

type CountRow = { value: number | null };

export type PlatformDay = {
  date: string;
  runs: number;
  conversations: number;
  activeUsers: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
};

export type PlatformUser = {
  userId: string;
  displayName: string | null;
  email: string | null;
  createdAt: number;
  workspaceCount: number;
  conversationCount: number;
  runCount: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  toolErrors: number;
  lastActiveAt: number | null;
  organizations: Array<{ id: string; name: string }>;
};

export type PlatformOverview = {
  generatedAt: number;
  periodDays: number;
  totals: {
    users: number;
    workspaces: number;
    organizations: number;
    conversations: number;
    runs: number;
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    toolErrors: number;
  };
  period: {
    runs: number;
    conversations: number;
    activeUsers: number;
    tokensIn: number;
    tokensOut: number;
    errors: number;
    previousRuns: number;
    previousTokensIn: number;
    previousTokensOut: number;
  };
  daily: PlatformDay[];
  statuses: Array<{ status: string; runs: number }>;
  models: Array<{ modelId: string; runs: number; tokensIn: number; tokensOut: number }>;
};

type TotalsRow = Omit<PlatformOverview["totals"], never>;
type PeriodRow = Omit<PlatformOverview["period"], "previousRuns" | "previousTokensIn" | "previousTokensOut">;

const number = (value: unknown): number => Number(value ?? 0) || 0;

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function organizationsFrom(raw: string | null): Array<{ id: string; name: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { id: string; name: string } =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { name?: unknown }).name === "string",
    );
  } catch {
    return [];
  }
}

export const adminAnalyticsRepository = {
  async overview(
    requestedDays = 30,
    now = Date.now(),
    dbImpl: typeof db = db,
  ): Promise<PlatformOverview> {
    const periodDays = Math.max(7, Math.min(90, Math.floor(requestedDays) || 30));
    const currentDay = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const periodStart = currentDay - (periodDays - 1) * DAY_MS;
    const previousStart = periodStart - periodDays * DAY_MS;

    const [totalsRows, periodRows, previousRows, runDays, conversationDays, statuses, models] =
      await Promise.all([
        dbImpl.all<TotalsRow>(sql`
          WITH run_totals AS (
            SELECT count(*) AS runs,
              coalesce(sum(tokens_in), 0) AS tokensIn,
              coalesce(sum(tokens_out), 0) AS tokensOut,
              coalesce(sum(tool_calls), 0) AS toolCalls,
              coalesce(sum(tool_errors), 0) AS toolErrors
            FROM ${runs}
          )
          SELECT
            (SELECT count(*) FROM ${users}) AS users,
            (SELECT count(*) FROM ${workspaces}) AS workspaces,
            (SELECT count(*) FROM ${organizations}) AS organizations,
            (SELECT count(*) FROM ${conversations}) AS conversations,
            run_totals.runs AS runs,
            run_totals.tokensIn AS tokensIn,
            run_totals.tokensOut AS tokensOut,
            run_totals.toolCalls AS toolCalls,
            run_totals.toolErrors AS toolErrors
          FROM run_totals
        `),
        dbImpl.all<PeriodRow>(sql`
          SELECT
            count(*) AS runs,
            count(DISTINCT conversation_id) AS conversations,
            count(DISTINCT ${workspaces.userId}) AS activeUsers,
            coalesce(sum(tokens_in), 0) AS tokensIn,
            coalesce(sum(tokens_out), 0) AS tokensOut,
            coalesce(sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
          FROM ${runs}
          LEFT JOIN ${workspaces} ON ${workspaces.id} = ${runs.workspaceId}
          WHERE ${runs.startedAt} >= ${periodStart} AND ${runs.startedAt} < ${currentDay + DAY_MS}
        `),
        dbImpl.all<{ runs: number; tokensIn: number; tokensOut: number }>(sql`
          SELECT
            count(*) AS runs,
            coalesce(sum(tokens_in), 0) AS tokensIn,
            coalesce(sum(tokens_out), 0) AS tokensOut
          FROM ${runs}
          WHERE ${runs.startedAt} >= ${previousStart} AND ${runs.startedAt} < ${periodStart}
        `),
        dbImpl.all<Omit<PlatformDay, "conversations">>(sql`
          SELECT
            strftime('%Y-%m-%d', ${runs.startedAt} / 1000, 'unixepoch') AS date,
            count(*) AS runs,
            count(DISTINCT ${workspaces.userId}) AS activeUsers,
            coalesce(sum(tokens_in), 0) AS tokensIn,
            coalesce(sum(tokens_out), 0) AS tokensOut,
            coalesce(sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
          FROM ${runs}
          LEFT JOIN ${workspaces} ON ${workspaces.id} = ${runs.workspaceId}
          WHERE ${runs.startedAt} >= ${periodStart} AND ${runs.startedAt} < ${currentDay + DAY_MS}
          GROUP BY date
          ORDER BY date
        `),
        dbImpl.all<{ date: string; conversations: number }>(sql`
          SELECT
            strftime('%Y-%m-%d', ${conversations.createdAt} / 1000, 'unixepoch') AS date,
            count(*) AS conversations
          FROM ${conversations}
          WHERE ${conversations.createdAt} >= ${periodStart} AND ${conversations.createdAt} < ${currentDay + DAY_MS}
          GROUP BY date
        `),
        dbImpl.all<{ status: string; runs: number }>(sql`
          SELECT status, count(*) AS runs
          FROM ${runs}
          WHERE ${runs.startedAt} >= ${periodStart} AND ${runs.startedAt} < ${currentDay + DAY_MS}
          GROUP BY status
          ORDER BY runs DESC, status
        `),
        dbImpl.all<{ modelId: string; runs: number; tokensIn: number; tokensOut: number }>(sql`
          SELECT model_id AS modelId, count(*) AS runs,
            coalesce(sum(tokens_in), 0) AS tokensIn,
            coalesce(sum(tokens_out), 0) AS tokensOut
          FROM ${runs}
          WHERE ${runs.startedAt} >= ${periodStart} AND ${runs.startedAt} < ${currentDay + DAY_MS}
          GROUP BY model_id
          ORDER BY runs DESC, (tokensIn + tokensOut) DESC, model_id
          LIMIT 8
        `),
      ]);

    const byDay = new Map<string, PlatformDay>();
    for (let index = 0; index < periodDays; index += 1) {
      const date = utcDate(periodStart + index * DAY_MS);
      byDay.set(date, { date, runs: 0, conversations: 0, activeUsers: 0, tokensIn: 0, tokensOut: 0, errors: 0 });
    }
    for (const row of runDays) {
      const day = byDay.get(row.date);
      if (!day) continue;
      Object.assign(day, {
        runs: number(row.runs),
        activeUsers: number(row.activeUsers),
        tokensIn: number(row.tokensIn),
        tokensOut: number(row.tokensOut),
        errors: number(row.errors),
      });
    }
    for (const row of conversationDays) {
      const day = byDay.get(row.date);
      if (day) day.conversations = number(row.conversations);
    }

    const totals = totalsRows[0] ?? ({} as TotalsRow);
    const period = periodRows[0] ?? ({} as PeriodRow);
    const previous = previousRows[0] ?? { runs: 0, tokensIn: 0, tokensOut: 0 };
    return {
      generatedAt: now,
      periodDays,
      totals: {
        users: number(totals.users),
        workspaces: number(totals.workspaces),
        organizations: number(totals.organizations),
        conversations: number(totals.conversations),
        runs: number(totals.runs),
        tokensIn: number(totals.tokensIn),
        tokensOut: number(totals.tokensOut),
        toolCalls: number(totals.toolCalls),
        toolErrors: number(totals.toolErrors),
      },
      period: {
        runs: number(period.runs),
        conversations: number(period.conversations),
        activeUsers: number(period.activeUsers),
        tokensIn: number(period.tokensIn),
        tokensOut: number(period.tokensOut),
        errors: number(period.errors),
        previousRuns: number(previous.runs),
        previousTokensIn: number(previous.tokensIn),
        previousTokensOut: number(previous.tokensOut),
      },
      daily: [...byDay.values()],
      statuses: statuses.map((row) => ({ status: row.status, runs: number(row.runs) })),
      models: models.map((row) => ({
        modelId: row.modelId,
        runs: number(row.runs),
        tokensIn: number(row.tokensIn),
        tokensOut: number(row.tokensOut),
      })),
    };
  },

  async listUsers(
    input: { limit?: number; offset?: number; query?: string },
    dbImpl: typeof db = db,
  ): Promise<{ users: PlatformUser[]; total: number }> {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const like = `%${query}%`;

    const matchesSearch = query === "" ? sql`1 = 1` : sql`
      lower(
        ${users.id} || ' ' || coalesce(${users.displayName}, '') || ' ' ||
        coalesce((
          SELECT min(${organizationMemberships.email})
          FROM ${organizationMemberships}
          WHERE ${organizationMemberships.userId} = ${users.id}
        ), '') || ' ' || coalesce((
          SELECT group_concat(${organizations.name}, ' ')
          FROM ${organizationMemberships}
          INNER JOIN ${organizations} ON ${organizations.id} = ${organizationMemberships.organizationId}
          WHERE ${organizationMemberships.userId} = ${users.id}
        ), '')
      ) LIKE ${like}
    `;

    type UserRow = {
      userId: string;
      displayName: string | null;
      email: string | null;
      createdAt: number;
      workspaceCount: number;
      conversationCount: number;
      runCount: number;
      tokensIn: number;
      tokensOut: number;
      toolCalls: number;
      toolErrors: number;
      lastActiveAt: number | null;
      organizations: string | null;
    };

    const [rows, countRows] = await Promise.all([
      dbImpl.all<UserRow>(sql`
      WITH selected_users AS (
        SELECT
          ${users.id} AS user_id,
          ${users.displayName} AS display_name,
          ${users.createdAt} AS created_at,
          (
            SELECT max(${runs.startedAt})
            FROM ${runs}
            INNER JOIN ${workspaces} ON ${workspaces.id} = ${runs.workspaceId}
            WHERE ${workspaces.userId} = ${users.id}
          ) AS last_active_at
        FROM ${users}
        WHERE ${matchesSearch}
        ORDER BY (last_active_at IS NULL), last_active_at DESC, ${users.createdAt} ASC, ${users.id}
        LIMIT ${limit} OFFSET ${offset}
      ), workspace_stats AS (
        SELECT ${workspaces.userId} AS user_id, count(*) AS workspace_count
        FROM ${workspaces}
        INNER JOIN selected_users ON selected_users.user_id = ${workspaces.userId}
        GROUP BY ${workspaces.userId}
      ), conversation_stats AS (
        SELECT ${workspaces.userId} AS user_id, count(*) AS conversation_count
        FROM ${conversations}
        INNER JOIN ${workspaces} ON ${workspaces.id} = ${conversations.workspaceId}
        INNER JOIN selected_users ON selected_users.user_id = ${workspaces.userId}
        GROUP BY ${workspaces.userId}
      ), run_stats AS (
        SELECT ${workspaces.userId} AS user_id,
          count(*) AS run_count,
          coalesce(sum(tokens_in), 0) AS tokens_in,
          coalesce(sum(tokens_out), 0) AS tokens_out,
          coalesce(sum(tool_calls), 0) AS tool_calls,
          coalesce(sum(tool_errors), 0) AS tool_errors,
          max(started_at) AS last_active_at
        FROM ${runs}
        INNER JOIN ${workspaces} ON ${workspaces.id} = ${runs.workspaceId}
        INNER JOIN selected_users ON selected_users.user_id = ${workspaces.userId}
        GROUP BY ${workspaces.userId}
      ), organization_stats AS (
        SELECT ${organizationMemberships.userId} AS user_id,
          min(${organizationMemberships.email}) AS email,
          json_group_array(json_object('id', ${organizations.id}, 'name', ${organizations.name})) AS organizations
        FROM ${organizationMemberships}
        INNER JOIN ${organizations} ON ${organizations.id} = ${organizationMemberships.organizationId}
        INNER JOIN selected_users ON selected_users.user_id = ${organizationMemberships.userId}
        GROUP BY ${organizationMemberships.userId}
      )
      SELECT
        selected_users.user_id AS userId,
        selected_users.display_name AS displayName,
        organization_stats.email AS email,
        selected_users.created_at AS createdAt,
        coalesce(workspace_stats.workspace_count, 0) AS workspaceCount,
        coalesce(conversation_stats.conversation_count, 0) AS conversationCount,
        coalesce(run_stats.run_count, 0) AS runCount,
        coalesce(run_stats.tokens_in, 0) AS tokensIn,
        coalesce(run_stats.tokens_out, 0) AS tokensOut,
        coalesce(run_stats.tool_calls, 0) AS toolCalls,
        coalesce(run_stats.tool_errors, 0) AS toolErrors,
        run_stats.last_active_at AS lastActiveAt,
        organization_stats.organizations AS organizations
      FROM selected_users
      LEFT JOIN workspace_stats ON workspace_stats.user_id = selected_users.user_id
      LEFT JOIN conversation_stats ON conversation_stats.user_id = selected_users.user_id
      LEFT JOIN run_stats ON run_stats.user_id = selected_users.user_id
      LEFT JOIN organization_stats ON organization_stats.user_id = selected_users.user_id
      ORDER BY (selected_users.last_active_at IS NULL), selected_users.last_active_at DESC,
        selected_users.created_at ASC, selected_users.user_id
      `),
      dbImpl.all<CountRow>(sql`
        SELECT count(*) AS value
        FROM ${users}
        WHERE ${matchesSearch}
      `),
    ]);

    return {
      total: number(countRows[0]?.value),
      users: rows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        createdAt: number(row.createdAt),
        workspaceCount: number(row.workspaceCount),
        conversationCount: number(row.conversationCount),
        runCount: number(row.runCount),
        tokensIn: number(row.tokensIn),
        tokensOut: number(row.tokensOut),
        toolCalls: number(row.toolCalls),
        toolErrors: number(row.toolErrors),
        lastActiveAt: row.lastActiveAt == null ? null : number(row.lastActiveAt),
        organizations: organizationsFrom(row.organizations),
      })),
    };
  },
};
