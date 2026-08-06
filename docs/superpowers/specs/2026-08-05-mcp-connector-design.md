# MCP connector — design

Date: 2026-08-05

## Problem

Salur's agent reaches three kinds of context today: files in its sandbox, PDFs
the user uploaded, and read-only SQL against connected databases. Everything
else — issue trackers, CRMs, internal APIs, anything a team already runs — needs
a bespoke tool written into `catalog/tools.ts` before the agent can touch it.

The Model Context Protocol is the general answer to that. A user points Salur at
an MCP server and the agent gains that server's tools, resources, and prompts
without a code change on our side.

Pi 0.83 (`@earendil-works/pi-agent-core`) has no MCP client of its own, so the
client and the Pi adaptation are ours to write.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Scope | Full connector: DB-backed, per workspace, with API and UI | Mirrors the database connector. An MCP server is user-supplied configuration, so it belongs where the user can manage it, not in a file only a developer edits. |
| Transports | Streamable HTTP (SSE fallback) **and** stdio | Remote servers are the safe common case; stdio is where most of the published server ecosystem lives. Excluding either would exclude half the useful servers. |
| stdio host | API host, command allowlist | Matches how skills already execute. The allowlist (`npx`, `uvx`, `node`, `python`, `python3`, `bun`, `deno`) with no shell interpolation is what keeps "add an MCP server" from meaning "run anything on the API host". |
| Surface | Tools **and** resources **and** prompts | The full MCP surface. Resources arrive as two flat tools rather than one tool per resource, so prompt weight stays constant as servers grow. |
| Secret storage | AES-256-GCM via the existing `lib/crypto.ts` | Same treatment as database connection strings. HTTP headers and stdio env vars are credentials. |
| Secret exposure | Never in a prompt, tool result, or transcript | `list()` selects explicit columns, so a new field cannot leak by being added. |
| Capability cache | `mcp_capabilities` table | The UI and the system-prompt block must work without opening a connection to every server on every page load. |
| Tool naming | `<server>__<tool>` | Two servers may both expose `search`. The prefix is what keeps the model's tool namespace unambiguous. |
| Connection lifetime | One set per run, disposed in `finally` | A long-lived pool would need health checks, reconnection, and per-workspace eviction. Runs are short; connecting per run is the smaller correct thing. |
| Gating | No `harnessTools` gate | The `db` tools are gated because every run would otherwise pay for them. An MCP server only exists in a workspace because the user added it — that *is* the opt-in. |
| Failure | A server that fails to connect is skipped | One unreachable server must not fail a run that never needed it. |

## Architecture

```
apps/api/src
  models/schema.ts                    + mcp_servers, mcp_capabilities
  db/client.ts                        + DDL, indexes, unique (workspace_id, name)
  repositories/
    mcp.repository.ts                 the only module touching those two tables
  services/mcp/
    allowlist.ts                      pure: is this stdio command permitted?
    client.ts                         @modelcontextprotocol/sdk Client + transports
    probe.ts                          connect -> list tools/resources/prompts -> cache
  services/mcp-tools.ts               createMcpTools(workspaceId) -> Pi tools
  controllers/mcp.controller.ts       HTTP in/out only
  routes/mcp.routes.ts                URL -> controller
  services/pi.service.ts              inject tools + prompt block, dispose in finally

apps/web/src
  components/mcp-panel.tsx            add / test / enable / remove
  lib/api.ts                          + MCP client calls
```

`allowlist.ts` is pure and dependency-free, for the same reason `sql-guard.ts`
is: it carries the security weight of the stdio transport and all of it is
unit-testable without spawning anything.

## Data model

```
mcp_servers
  id            TEXT PRIMARY KEY
  workspace_id  TEXT
  name          TEXT NOT NULL          -- how the agent refers to it
  transport     TEXT NOT NULL          -- 'http' | 'stdio'
  url           TEXT                   -- http only
  headers_enc   TEXT                   -- http only, encrypted JSON object
  command       TEXT                   -- stdio only
  args_json     TEXT                   -- stdio only, JSON array
  env_enc       TEXT                   -- stdio only, encrypted JSON object
  enabled       INTEGER NOT NULL DEFAULT 1
  status        TEXT NOT NULL DEFAULT 'connected'   -- 'connected' | 'error'
  error         TEXT
  tool_count    INTEGER NOT NULL DEFAULT 0
  last_probed_at INTEGER
  created_at    INTEGER NOT NULL
  UNIQUE (workspace_id, name)

mcp_capabilities
  id           TEXT PRIMARY KEY
  server_id    TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE
  workspace_id TEXT
  kind         TEXT NOT NULL           -- 'tool' | 'resource' | 'prompt'
  name         TEXT NOT NULL
  description  TEXT
  schema_json  TEXT                    -- tool inputSchema / prompt arguments
  uri          TEXT                    -- resources only
```

The unique index on `(workspace_id, name)` exists for the same reason it does on
`db_connections`: the agent addresses a server by name, so two servers called
`github` in one workspace would make `github__search` ambiguous. Two different
workspaces may each have one.

## What the agent sees

**Tools.** Every cached tool from every enabled server becomes a Pi `AgentTool`
named `<server>__<tool>`, slugified to `[a-z0-9_]`. The MCP `inputSchema` (JSON
Schema) converts to typebox through `JSON_SCHEMA_TO_TYPEBOX` in `pi.service.ts`,
which is extended here to handle nested objects — it returns `Type.Any()` for
them today, which is correct for our hand-written tools and lossy for arbitrary
server schemas.

**Resources.** Two tools regardless of how many resources exist:
`mcp_list_resources(server?)` and `mcp_read_resource(server, uri)`. One tool per
resource would put an unbounded list in every system prompt.

**Prompts.** Each MCP prompt registers as a Pi prompt template named
`<server>__<prompt>`, appended to the `resources.promptTemplates` the
`AgentHarness` already receives from `apps/api/prompts/*.md`.

**System prompt.** An `mcpPrompt` block alongside the existing `docsPrompt` and
`dbPrompt`, naming each connected server and its tools. Built from the
capability cache, so it costs no connection.

## Error handling

- Connect timeout 10s per server; tool-call timeout 60s.
- A server that fails to connect at run start is logged, its `status`/`error`
  persisted, and skipped. The run proceeds with the remaining servers.
- A tool call that throws returns an error content block to the model rather
  than aborting the run — the model can then choose another approach.
- `POST /api/mcp` probes before it inserts, so a server that cannot be reached
  is reported to the user at the moment they add it.

## Security

- `headers_enc` and `env_enc` are AES-256-GCM, keyed the same way as database
  credentials. `list()` never selects them.
- stdio commands are matched against the allowlist by `argv[0]` only, spawned
  without a shell, and given an explicit env rather than inheriting the API
  process's. A command like `sh -c "..."` is rejected, as is any path
  containing a traversal segment.
- MCP tool *results* are model-visible by definition. A malicious server can
  attempt prompt injection through them; this is inherent to MCP and is noted
  as a known limitation rather than solved here.

## Testing

1. `mcp.repository.test.ts` — CRUD, workspace scoping, duplicate-name rejection,
   and that encrypted headers/env never appear in `list()` output.
2. `allowlist.test.ts` — accepts the allowlisted binaries, rejects `sh -c`,
   rejects path traversal, rejects an empty command.
3. `mcp-tools.test.ts` — a fake MCP server over the SDK's `InMemoryTransport`:
   tool name mapping, JSON-Schema→typebox conversion, resource and prompt
   exposure, and that one unreachable server does not remove another's tools.

## Known limitations

- A malicious or compromised MCP server can inject instructions through tool
  results. Nothing here prevents that.
- stdio servers run on the API host, not inside the workspace sandbox. The
  allowlist limits what can start; it does not isolate what runs.
- Connections are per-run, so a server with expensive startup pays that cost on
  every run.
- No OAuth flow. HTTP servers authenticate with static headers only.
