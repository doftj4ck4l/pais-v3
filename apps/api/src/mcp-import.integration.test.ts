import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Copying an MCP server between a user's workspaces, over the real HTTP
 * surface.
 *
 * At the repository boundary this would assert almost nothing worth asserting:
 * the parts that can be wrong are the ownership check on the *source*
 * workspace — without which the endpoint reads any workspace's encrypted
 * credentials by id — and the name collision that a copy always risks, and both
 * live in the controller.
 *
 * Every server here is HTTP pointed at a closed port. The import probes what it
 * stores, and a stdio server would mean spawning a package manager to learn
 * nothing: a refused connection is stored the same way, with the same row.
 */

let dir: string;
let createApp: typeof import("./app").createApp;

const asUser = (id: string) => ({ headers: { "x-authentik-uid": id } });

const asUserJson = (id: string) => ({
  ...asUser(id).headers,
  "content-type": "application/json",
});

/** Nothing listens here, so the probe fails fast and the row lands as "error". */
const DEAD_URL = "http://127.0.0.1:1/mcp";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-mcp-import-"));
  process.env.DB_PATH = path.join(dir, "app.db");
  const { ensureSchema } = await import("./db/client");
  ensureSchema();

  // Without a connection secret the API refuses to store a credential at all
  // and every case here is a 503.
  //
  // Set on the `env` object rather than on `process.env`, which is what this
  // used to do and what made the file pass alone and fail in a suite:
  // `config/env` reads `process.env` once, at import. Run on its own this
  // block is the first thing to touch it; run with 44 other files, something
  // else has already imported it and the assignment is too late. It looked
  // fine locally only because `apps/api/.env` is not in git — it supplied a
  // real secret here and nothing at all in CI. Same shape as
  // `mcp.repository.test.ts`, which mutates `env` for the same reason.
  const { env } = await import("./config/env");
  (env as { connectionSecret: string }).connectionSecret = "test-secret-for-mcp-import";

  ({ createApp } = await import("./app"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function makeWorkspace(user: string, name: string): Promise<string> {
  const res = await createApp().request("/api/workspaces", {
    method: "POST",
    headers: asUserJson(user),
    body: JSON.stringify({ name }),
  });
  const { workspace } = (await res.json()) as { workspace: { id: string } };
  return workspace.id;
}

async function addServer(
  user: string,
  workspaceId: string,
  name: string,
  headers: Record<string, string> = { Authorization: "Bearer secret-token" },
): Promise<string> {
  const res = await createApp().request(`/api/mcp?workspaceId=${workspaceId}`, {
    method: "POST",
    headers: asUserJson(user),
    body: JSON.stringify({ name, transport: "http", url: DEAD_URL, headers }),
  });
  const { server } = (await res.json()) as { server: { id: string } };
  return server.id;
}

async function listServers(user: string, workspaceId: string) {
  const res = await createApp().request(`/api/mcp?workspaceId=${workspaceId}`, asUser(user));
  const { servers } = (await res.json()) as {
    servers: { id: string; name: string; url: string; headerKeys: string[] }[];
  };
  return servers;
}

describe("GET /api/mcp", () => {
  it("labels Nextcloud tools with the same fail-closed access policy used at execution", async () => {
    const user = "nextcloud-tool-access-user";
    const workspaceId = await makeWorkspace(user, "Nextcloud access");
    const serverId = await addServer(user, workspaceId, "nextcloud");
    const unrelatedServerId = await addServer(user, workspaceId, "github");
    const { mcpStore } = await import("./repositories/mcp.repository");
    await mcpStore.saveCapabilities(workspaceId, serverId, [
      {
        kind: "tool",
        name: "nc_webdav_read_file",
        description: "Read a file",
        annotationsJson: JSON.stringify({ readOnlyHint: true }),
      },
      {
        kind: "tool",
        name: "nc_webdav_write_file",
        description: "Write a file",
        annotationsJson: JSON.stringify({ readOnlyHint: false }),
      },
      {
        kind: "tool",
        name: "nc_webdav_mystery_action",
        description: "An unclassified action",
      },
    ]);
    await mcpStore.saveCapabilities(workspaceId, unrelatedServerId, [
      {
        kind: "tool",
        name: "search_issues",
        description: "Search issues",
        annotationsJson: JSON.stringify({ readOnlyHint: true }),
      },
    ]);

    const res = await createApp().request(
      `/api/mcp?workspaceId=${workspaceId}`,
      asUser(user),
    );
    const body = (await res.json()) as {
      servers: {
        id: string;
        capabilities: { name: string; access: "read" | "write" | null }[];
      }[];
    };
    const capabilities = body.servers.find((server) => server.id === serverId)!.capabilities;

    expect(capabilities.map(({ name, access }) => ({ name, access }))).toEqual([
      { name: "nc_webdav_read_file", access: "read" },
      { name: "nc_webdav_write_file", access: "write" },
      { name: "nc_webdav_mystery_action", access: "write" },
    ]);
    expect(
      body.servers.find((server) => server.id === unrelatedServerId)!.capabilities,
    ).toEqual([
      expect.objectContaining({ name: "search_issues", access: null }),
    ]);
  });
});

describe("GET /api/mcp/importable", () => {
  it("lists other workspaces' servers and never the current one's", async () => {
    const user = "importable-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Client work");
    await addServer(user, home, "here", { Authorization: "Bearer here" });
    await addServer(user, other, "there", { Authorization: "Bearer there" });

    const res = await createApp().request(`/api/mcp/importable?workspaceId=${home}`, asUser(user));
    const { sources } = (await res.json()) as {
      sources: { workspaceId: string; workspaceName: string; servers: { name: string }[] }[];
    };

    expect(sources.map((s) => s.workspaceName)).toEqual(["Client work"]);
    expect(sources[0]!.servers.map((s) => s.name)).toEqual(["there"]);
  });

  it("names the credentials that would travel, and never their values", async () => {
    const user = "importable-keys-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Other");
    await addServer(user, other, "tracker", { Authorization: "Bearer do-not-leak" });

    const res = await createApp().request(`/api/mcp/importable?workspaceId=${home}`, asUser(user));
    const body = await res.text();

    expect(JSON.parse(body).sources[0].servers[0].headerKeys).toEqual(["Authorization"]);
    expect(body).not.toContain("do-not-leak");
  });

  it("flags a name this workspace has already taken by a different server", async () => {
    const user = "importable-clash-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Other");
    // Same name, different credential — a genuinely different connection that
    // would have to be renamed on arrival.
    await addServer(user, home, "nextcloud", { Authorization: "Bearer home-token" });
    await addServer(user, other, "nextcloud", { Authorization: "Bearer other-token" });

    const res = await createApp().request(`/api/mcp/importable?workspaceId=${home}`, asUser(user));
    const { sources } = (await res.json()) as {
      sources: { servers: { nameTaken: boolean }[] }[];
    };

    expect(sources[0]!.servers[0]!.nameTaken).toBe(true);
  });

  it("leaves out a server this workspace is already connected to", async () => {
    const user = "importable-dupe-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Other");
    // Same URL and the same credential — the same connection, under whatever
    // name each workspace gave it.
    await addServer(user, home, "tracker", { Authorization: "Bearer same" });
    await addServer(user, other, "tracker-elsewhere", { Authorization: "Bearer same" });

    const res = await createApp().request(`/api/mcp/importable?workspaceId=${home}`, asUser(user));

    // The workspace drops out entirely rather than appearing with an empty
    // list, so the screen has nothing to draw a heading for.
    expect(await res.json()).toEqual({ sources: [], alreadyHere: 1 });
  });

  it("says nothing about another user's workspaces", async () => {
    const stranger = "importable-stranger";
    const owner = "importable-owner";
    await makeWorkspace(owner, "Private");
    await addServer(owner, (await listWorkspaces(owner))[0]!.id, "private-server");
    const mine = await makeWorkspace(stranger, "Mine");

    const res = await createApp().request(`/api/mcp/importable?workspaceId=${mine}`, asUser(stranger));

    expect(await res.json()).toEqual({ sources: [], alreadyHere: 0 });
  });
});

describe("POST /api/mcp/import", () => {
  it("copies the server and its credentials into the target workspace", async () => {
    const user = "import-copy-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Other");
    const sourceId = await addServer(user, other, "nextcloud");

    const res = await createApp().request(`/api/mcp/import?workspaceId=${home}`, {
      method: "POST",
      headers: asUserJson(user),
      body: JSON.stringify({ sourceWorkspaceId: other, serverId: sourceId }),
    });

    expect(res.status).toBe(201);
    const copied = (await listServers(user, home))[0]!;
    expect(copied.name).toBe("nextcloud");
    expect(copied.url).toBe(DEAD_URL);
    // The point of the feature: the credential came with it, so the user does
    // not retype a token they already gave us.
    expect(copied.headerKeys).toEqual(["Authorization"]);
    // A copy, not a move.
    expect(await listServers(user, other)).toHaveLength(1);
  });

  it("suffixes the name when this workspace already has a different one", async () => {
    const user = "import-clash-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Other");
    await addServer(user, home, "plane", { Authorization: "Bearer home-key" });
    const sourceId = await addServer(user, other, "plane", { Authorization: "Bearer other-key" });

    const res = await createApp().request(`/api/mcp/import?workspaceId=${home}`, {
      method: "POST",
      headers: asUserJson(user),
      body: JSON.stringify({ sourceWorkspaceId: other, serverId: sourceId }),
    });

    expect(res.status).toBe(201);
    expect((await listServers(user, home)).map((s) => s.name).sort()).toEqual(["plane", "plane-2"]);
  });

  it("refuses a server this workspace is already connected to", async () => {
    const user = "import-dupe-user";
    const home = await makeWorkspace(user, "Home");
    const other = await makeWorkspace(user, "Other");
    await addServer(user, home, "already", { Authorization: "Bearer identical" });
    const sourceId = await addServer(user, other, "same-thing", {
      Authorization: "Bearer identical",
    });

    // The picker hides these, so this is the stale-list and direct-call path.
    const res = await createApp().request(`/api/mcp/import?workspaceId=${home}`, {
      method: "POST",
      headers: asUserJson(user),
      body: JSON.stringify({ sourceWorkspaceId: other, serverId: sourceId }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already");
    expect(await listServers(user, home)).toHaveLength(1);
  });

  it("refuses a source workspace the caller does not own", async () => {
    const owner = "import-owner";
    const stranger = "import-stranger";
    const theirs = await makeWorkspace(owner, "Theirs");
    const sourceId = await addServer(owner, theirs, "secretive");
    const mine = await makeWorkspace(stranger, "Mine");

    const res = await createApp().request(`/api/mcp/import?workspaceId=${mine}`, {
      method: "POST",
      headers: asUserJson(stranger),
      body: JSON.stringify({ sourceWorkspaceId: theirs, serverId: sourceId }),
    });

    expect(res.status).toBe(404);
    expect(await listServers(stranger, mine)).toHaveLength(0);
  });

  it("refuses importing a workspace into itself", async () => {
    const user = "import-self-user";
    const home = await makeWorkspace(user, "Home");
    const sourceId = await addServer(user, home, "self");

    const res = await createApp().request(`/api/mcp/import?workspaceId=${home}`, {
      method: "POST",
      headers: asUserJson(user),
      body: JSON.stringify({ sourceWorkspaceId: home, serverId: sourceId }),
    });

    expect(res.status).toBe(400);
    expect(await listServers(user, home)).toHaveLength(1);
  });
});

async function listWorkspaces(user: string) {
  const res = await createApp().request("/api/workspaces", asUser(user));
  const { workspaces } = (await res.json()) as { workspaces: { id: string }[] };
  return workspaces;
}
