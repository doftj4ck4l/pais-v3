import type { Context } from "hono";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import {
  DuplicateServerNameError,
  mcpStore,
  type NewMcpServer,
} from "../repositories/mcp.repository";
import { connectMcpServer, McpConnectError, type McpServerSpec } from "../services/mcp/client";
import { listCapabilities } from "../services/mcp/probe";
import { checkStdioCommand } from "../services/mcp/allowlist";
import { currentUserId } from "../middleware/auth";

/**
 * HTTP in, HTTP out. Every decision that is not about the request itself lives
 * in the repository or the mcp services.
 */

/**
 * The workspace this request applies to. `resolve` is the one place a
 * client-supplied workspace id is checked against ownership.
 */
const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

const newServerId = () =>
  `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Names reach the model as a tool-name prefix, so they are constrained. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/i;

/** GET /api/mcp — a workspace's servers, newest first, never with a credential. */
export async function index(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const servers = await mcpStore.list(workspaceId);
  const capabilities = await mcpStore.capabilities(workspaceId);

  // Grouped here rather than in the repository: this shape exists for the
  // settings panel, and nothing else needs it.
  const byServer = new Map<string, typeof capabilities>();
  for (const cap of capabilities) {
    const list = byServer.get(cap.serverId) ?? [];
    list.push(cap);
    byServer.set(cap.serverId, list);
  }

  // Credential *names*, never values. An edit form has to show what is already
  // configured — otherwise changing a URL means retyping every password blind —
  // and a key like NEXTCLOUD_PASSWORD is already public in the connector
  // catalog. The values stay behind `resolveSecrets`.
  const secretKeys = new Map<string, { headers: string[]; env: string[] }>();
  for (const s of servers) {
    const secrets = await mcpStore.resolveSecrets(workspaceId, s.id);
    secretKeys.set(s.id, {
      headers: Object.keys(secrets?.headers ?? {}).sort(),
      env: Object.keys(secrets?.env ?? {}).sort(),
    });
  }

  return c.json({
    servers: servers.map((s) => ({
      ...s,
      args: s.argsJson ? JSON.parse(s.argsJson) : [],
      headerKeys: secretKeys.get(s.id)?.headers ?? [],
      envKeys: secretKeys.get(s.id)?.env ?? [],
      capabilities: (byServer.get(s.id) ?? []).map((cap) => ({
        kind: cap.kind,
        name: cap.name,
        description: cap.description,
        uri: cap.uri,
      })),
    })),
  });
}

type Parsed =
  | { ok: false; status: 400 | 409 | 503; error: string }
  | { ok: true; server: NewMcpServer; suppliedSecrets: boolean };

/**
 * Validate a request body into something storable.
 *
 * The stdio allowlist is applied here as well as at connect time. Rejecting a
 * disallowed command when it is *added* tells the user immediately; the check
 * at connect time is what makes it a boundary rather than a form validation.
 *
 * Shared by create and edit, which is the point: an edit that skipped this
 * would be a way to move a server onto a command the allowlist forbids, and
 * the allowlist would have been enforced only on the path nobody attacks.
 * `existing` keeps a server's own name from colliding with itself.
 */
async function parseBody(
  c: Context,
  workspaceId: string,
  existing?: { id: string },
): Promise<Parsed> {
  if (!env.connectionSecret) {
    return {
      ok: false,
      status: 503,
      error: "CONNECTION_SECRET is not set — the API will not store an MCP credential",
    };
  }

  let body: {
    name?: string;
    transport?: string;
    url?: string;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, status: 400, error: "Expected a JSON body" };
  }

  const name = String(body.name ?? "").trim();
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 400,
      error: "Name must be 1-31 letters, digits, hyphens or underscores",
    };
  }

  const transport = String(body.transport ?? "").trim();
  if (transport !== "http" && transport !== "stdio") {
    return { ok: false, status: 400, error: 'Transport must be "http" or "stdio"' };
  }

  const clash = await mcpStore.findByName(workspaceId, name);
  if (clash && clash.id !== existing?.id) {
    return { ok: false, status: 409, error: `An MCP server named "${name}" already exists` };
  }

  const server: NewMcpServer = {
    id: existing?.id ?? newServerId(),
    workspaceId,
    name,
    transport: transport,
  };

  if (transport === "http") {
    const url = String(body.url ?? "").trim();
    if (!url) return { ok: false, status: 400, error: "A server URL is required" };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, status: 400, error: "URL must be http or https" };
      }
    } catch {
      return { ok: false, status: 400, error: `"${url}" is not a valid URL` };
    }
    server.url = url;
    server.headers = sanitiseMap(body.headers);
  } else {
    const command = String(body.command ?? "").trim();
    const args = Array.isArray(body.args) ? body.args.map((a) => String(a)) : [];
    const allowed = checkStdioCommand(command, args);
    if (!allowed.ok) return { ok: false, status: 400, error: allowed.reason };
    server.command = command;
    server.args = args;
    server.env = sanitiseMap(body.env);
  }

  // Whether the *request* carried credentials, which is not the same question
  // as whether `server.headers`/`server.env` ended up empty — sanitiseMap turns
  // both "absent" and "{}" into {}. An edit needs the distinction to tell
  // "leave my password alone" apart from "clear it".
  const suppliedSecrets = transport === "http" ? body.headers !== undefined : body.env !== undefined;

  return { ok: true, server, suppliedSecrets };
}

/** Drop anything that is not a string-to-string pair before it is encrypted. */
function sanitiseMap(map: unknown): Record<string, string> {
  if (!map || typeof map !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof k === "string" && k.trim() && (typeof v === "string" || typeof v === "number")) {
      out[k.trim()] = String(v);
    }
  }
  return out;
}

/** Connect, read what the server offers, cache it, and record the outcome. */
async function probeAndCache(
  workspaceId: string,
  spec: McpServerSpec,
): Promise<{ ok: boolean; error?: string; detail?: string | null; toolCount: number }> {
  try {
    const conn = await connectMcpServer(spec);
    try {
      const caps = await listCapabilities(conn);
      await mcpStore.saveCapabilities(workspaceId, spec.id, caps);
      await mcpStore.markStatus(workspaceId, spec.id, "connected", null, null);
      return { ok: true, toolCount: caps.filter((cap) => cap.kind === "tool").length };
    } finally {
      await conn.close();
    }
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    // What the process actually said, when it said anything. `connect ... timed
    // out` names the symptom; this is the only place the cause survives.
    const detail = e instanceof McpConnectError ? e.detail : null;
    logger.warn("mcp.probe_failed", {
      server: spec.name,
      message: error,
      detailChars: detail?.length ?? 0,
    });
    await mcpStore.markStatus(workspaceId, spec.id, "error", error, detail);
    return { ok: false, error, detail, toolCount: 0 };
  }
}

/** Re-read a row we just wrote. A miss should be impossible; say so if it happens. */
async function readBack(workspaceId: string, id: string) {
  return (await mcpStore.list(workspaceId)).find((r) => r.id === id) ?? null;
}

/**
 * POST /api/mcp — add a server and probe it.
 *
 * A server that cannot be reached is still stored, with the reason, so the user
 * can see and fix it. Only a genuinely invalid request is rejected outright —
 * except a disallowed stdio command, which is rejected because storing it would
 * mean storing something we will never agree to run.
 */
export async function create(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const parsed = await parseBody(c, workspaceId);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const { server } = parsed;
  try {
    await mcpStore.create(server);
  } catch (e) {
    // findByName above is check-then-act: a second request for the same name
    // can race past it and hit the unique index instead. That must still
    // surface as the same 409, not an unhandled 500.
    if (e instanceof DuplicateServerNameError) return c.json({ error: e.message }, 409);
    throw e;
  }

  const probe = await probeAndCache(workspaceId, {
    id: server.id,
    name: server.name,
    transport: server.transport,
    url: server.url,
    headers: server.headers,
    command: server.command,
    args: server.args,
    env: server.env,
  });

  const stored = await readBack(workspaceId, server.id);
  if (!stored) return c.json({ error: "Server was stored but could not be re-read" }, 500);
  return c.json({ server: stored, reachable: probe.ok, error: probe.error ?? null }, 201);
}

/** POST /api/mcp/:id/refresh — reconnect and re-read what the server offers. */
export async function refresh(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing server id" }, 400);

  const row = (await mcpStore.list(workspaceId)).find((r) => r.id === id);
  if (!row) return c.json({ error: "Server not found" }, 404);

  const secrets = await mcpStore.resolveSecrets(workspaceId, id);
  const probe = await probeAndCache(workspaceId, {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    headers: secrets?.headers ?? {},
    command: row.command,
    args: row.argsJson ? JSON.parse(row.argsJson) : [],
    env: secrets?.env ?? {},
  });

  return c.json({ server: await readBack(workspaceId, id), reachable: probe.ok });
}

/**
 * PATCH /api/mcp/:id — toggle a server, or edit its connection.
 *
 * Two shapes on one verb. `{ enabled }` alone stays the cheap toggle it always
 * was and does not touch the connection or re-probe; anything carrying `name`
 * or `transport` is a full edit and goes through the same validation as create.
 * Keeping the toggle intact matters — the settings panel calls it on every
 * checkbox click, and re-probing there would turn a checkbox into a network
 * round trip.
 */
export async function update(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing server id" }, 400);

  let body: { enabled?: boolean; name?: string; transport?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const row = (await mcpStore.list(workspaceId)).find((r) => r.id === id);
  if (!row) return c.json({ error: "Server not found" }, 404);

  const isEdit = body.name !== undefined || body.transport !== undefined;
  if (!isEdit) {
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: '"enabled" must be true or false' }, 400);
    }
    await mcpStore.setEnabled(workspaceId, id, body.enabled);
    return c.json({ server: await readBack(workspaceId, id) });
  }

  // Hono caches the parsed body, so parseBody re-reading it is free.
  const parsed = await parseBody(c, workspaceId, { id });
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const { server, suppliedSecrets } = parsed;

  try {
    const ok = await mcpStore.update(workspaceId, id, {
      name: server.name,
      transport: server.transport,
      url: server.url,
      // Undefined leaves the stored credential alone. See McpConnectionUpdate.
      headers: suppliedSecrets ? server.headers : undefined,
      command: server.command,
      args: server.args,
      env: suppliedSecrets ? server.env : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    if (!ok) return c.json({ error: "Server not found" }, 404);
  } catch (e) {
    if (e instanceof DuplicateServerNameError) return c.json({ error: e.message }, 409);
    throw e;
  }

  // The cached catalog describes the server as it was. Dropping it *before* the
  // re-probe is what makes a failed edit safe: a bad new URL leaves the server
  // with no tools rather than advertising the old server's tools under a
  // connection that no longer reaches them.
  await mcpStore.clearCapabilities(workspaceId, id);

  // Secrets that were not re-sent still have to reach the probe, so they are
  // read back from storage rather than taken from the request.
  const secrets = await mcpStore.resolveSecrets(workspaceId, id);
  const probe = await probeAndCache(workspaceId, {
    id,
    name: server.name,
    transport: server.transport,
    url: server.url,
    headers: secrets?.headers ?? {},
    command: server.command,
    args: server.args ?? [],
    env: secrets?.env ?? {},
  });

  logger.info("mcp.updated", { id, name: server.name, reachable: probe.ok });
  return c.json({
    server: await readBack(workspaceId, id),
    reachable: probe.ok,
    error: probe.error ?? null,
  });
}

/**
 * GET /api/mcp/importable — servers this user already configured elsewhere.
 *
 * Setting a server up is the expensive part: a host, a username and an app
 * password typed correctly, or a token pasted from another product's settings
 * page. Doing that again for every workspace is retyping a credential the API
 * already holds, and retyping is where it gets mistyped.
 *
 * Only workspaces this user owns are looked at, and only public columns leave —
 * the credential *names* travel so the picker can say what will come with it,
 * the values never do.
 */
export async function importable(c: Context) {
  const userId = currentUserId(c);
  const currentId = await workspaceIdOf(c);
  const workspaces = (await workspaceRegistry.list(userId)).filter((w) => w.id !== currentId);

  // Names are unique per workspace, so a server already here by name is one the
  // user would have to rename on arrival. Flagged rather than hidden: seeing
  // "already here" is the answer to "why is Nextcloud missing from this list".
  const taken = new Set((await mcpStore.list(currentId)).map((s) => s.name));

  const sources = [];
  for (const workspace of workspaces) {
    const servers = await mcpStore.list(workspace.id);
    if (!servers.length) continue;

    const described = [];
    for (const s of servers) {
      const secrets = await mcpStore.resolveSecrets(workspace.id, s.id);
      described.push({
        id: s.id,
        name: s.name,
        transport: s.transport,
        url: s.url,
        command: s.command,
        args: s.argsJson ? (JSON.parse(s.argsJson) as string[]) : [],
        status: s.status,
        toolCount: s.toolCount,
        headerKeys: Object.keys(secrets?.headers ?? {}).sort(),
        envKeys: Object.keys(secrets?.env ?? {}).sort(),
        nameTaken: taken.has(s.name),
      });
    }

    sources.push({ workspaceId: workspace.id, workspaceName: workspace.name, servers: described });
  }

  return c.json({ sources });
}

/**
 * POST /api/mcp/import — copy a server from another of this user's workspaces.
 *
 * A copy, not a share: the row and its credentials are duplicated, so editing
 * or removing it here leaves the original alone. Sharing one row across
 * workspaces would make a workspace's tool list depend on a workspace the user
 * may have deleted.
 *
 * The source workspace goes through `getOwned` before anything is read from it.
 * That is the whole security check — without it this endpoint reads any
 * workspace's encrypted credentials by id.
 */
export async function importServer(c: Context) {
  const userId = currentUserId(c);
  const workspaceId = await workspaceIdOf(c);

  let body: { sourceWorkspaceId?: string; serverId?: string; name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const sourceWorkspaceId = String(body.sourceWorkspaceId ?? "").trim();
  const serverId = String(body.serverId ?? "").trim();
  if (!sourceWorkspaceId || !serverId) {
    return c.json({ error: "sourceWorkspaceId and serverId are required" }, 400);
  }
  if (sourceWorkspaceId === workspaceId) {
    return c.json({ error: "That server is already in this workspace" }, 400);
  }

  const source = await workspaceRegistry.getOwned(sourceWorkspaceId, userId);
  if (!source) return c.json({ error: "Workspace not found" }, 404);

  const row = (await mcpStore.list(sourceWorkspaceId)).find((r) => r.id === serverId);
  if (!row) return c.json({ error: "Server not found" }, 404);

  if (!env.connectionSecret) {
    return c.json(
      { error: "CONNECTION_SECRET is not set — the API will not store an MCP credential" },
      503,
    );
  }

  // A requested name is still a name, so it faces the same pattern the create
  // form does; without one, the original's name is carried over and only
  // suffixed if this workspace already has it.
  const requested = String(body.name ?? "").trim();
  if (requested && !NAME_PATTERN.test(requested)) {
    return c.json({ error: "Name must be 1-31 letters, digits, hyphens or underscores" }, 400);
  }
  const name = await freeName(workspaceId, requested || row.name);
  if (!name) {
    return c.json({ error: `An MCP server named "${requested || row.name}" already exists` }, 409);
  }

  const secrets = await mcpStore.resolveSecrets(sourceWorkspaceId, serverId);
  const args = row.argsJson ? (JSON.parse(row.argsJson) as string[]) : [];

  // The allowlist is re-applied rather than trusted. A row stored before a
  // command was removed from the allowlist must not be a way back in.
  if (row.transport === "stdio") {
    const allowed = checkStdioCommand(row.command ?? "", args);
    if (!allowed.ok) return c.json({ error: allowed.reason }, 400);
  }

  const server: NewMcpServer = {
    id: newServerId(),
    workspaceId,
    name,
    transport: row.transport,
    url: row.url ?? undefined,
    headers: secrets?.headers,
    command: row.command ?? undefined,
    args,
    env: secrets?.env,
  };

  try {
    await mcpStore.create(server);
  } catch (e) {
    if (e instanceof DuplicateServerNameError) return c.json({ error: e.message }, 409);
    throw e;
  }

  const probe = await probeAndCache(workspaceId, {
    id: server.id,
    name: server.name,
    transport: server.transport,
    url: server.url,
    headers: server.headers,
    command: server.command,
    args: server.args,
    env: server.env,
  });

  logger.info("mcp.imported", {
    from: sourceWorkspaceId,
    to: workspaceId,
    name,
    reachable: probe.ok,
  });

  const stored = await readBack(workspaceId, server.id);
  if (!stored) return c.json({ error: "Server was stored but could not be re-read" }, 500);
  return c.json({ server: stored, reachable: probe.ok, error: probe.error ?? null }, 201);
}

/**
 * The first unused name in this workspace, starting from `base`.
 *
 * An import is a copy, and two copies of "nextcloud" collide on the unique
 * index. Suffixing is what the user would do by hand; refusing would mean the
 * only way to import a second Nextcloud is to guess a name the form never
 * showed them. Null when even the suffixed forms are taken — 20 of them is far
 * past a real workspace and short of a loop that never ends.
 */
async function freeName(workspaceId: string, base: string): Promise<string | null> {
  if (!(await mcpStore.findByName(workspaceId, base))) return base;
  for (let n = 2; n <= 20; n++) {
    // Names are capped at 31 characters, so the suffix eats into the base
    // rather than pushing the result past what the pattern allows.
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!(await mcpStore.findByName(workspaceId, candidate))) return candidate;
  }
  return null;
}

/** DELETE /api/mcp/:id — removes the cached capabilities too, by cascade. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing server id" }, 400);

  const removed = await mcpStore.remove(await workspaceIdOf(c), id);
  if (!removed) return c.json({ error: "Server not found" }, 404);
  return c.body(null, 204);
}
