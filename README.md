# Pixelspace

An agent console that runs one **tool-calling agent** across selectable models.
The agent automatically gains capabilities from the resources connected to its
workspace, including documents, databases, calendars, and MCP servers.

```
packages
  apps/api   – Hono + Bun agent server (SSE streaming, OpenAI-compatible)
  apps/web   – Vite + React console UI (Tailwind v4 + shadcn/ui)
```

## Quick start

```bash
bun run setup          # deps, .env, and the sandbox image
bun run dev            # API on :4000, web on :5173
```

Open http://localhost:5173.

For a persistent single-host installation on Linux, use the on-prem operator
instead of the development setup:

```bash
./install.sh --admin-email operator@example.com
scripts/pixelspace doctor
```

It generates private host configuration, builds or pulls the application and
sandbox images, starts Compose, and verifies the public `/api/meta` path. The
secure default listens only on `127.0.0.1:8080`. Unless a protected password
file is supplied, installation generates a random first-administrator password
and shows it once after account creation. LAN exposure requires TLS or the
trusted authentication proxy described below. See [ON_PREM.md](ON_PREM.md) for
DGX Spark, authentication, lifecycle, backup, restore, and upgrade instructions.

For a task-oriented walkthrough from cloning the repository through first login
and daily operation, use the [Pixelspace setup manual](SETUP_MANUAL.md).

On a DGX Spark, Pixelspace can manage the supported Nemotron runtime on its
private Compose network:

```bash
./install.sh \
  --profile dgx-spark \
  --model-pack nemotron-3.5-lightning \
  --admin-email operator@example.com
```

`setup` is idempotent — re-run it any time. It installs dependencies, creates
`apps/api/.env` from the example if missing, and builds the sandbox image. It
finishes by listing anything it could not do rather than failing silently, so a
missing API key or a stopped Docker daemon is reported instead of surfacing
later as a broken run.

Two things it cannot do for you: put a real key in `.env`, and start Docker.

| Command | What it does |
| --- | --- |
| `bun run setup` | Everything a fresh clone needs |
| `bun run dev` | API + web together |
| `bun run dev:api` / `bun run dev:web` | One at a time |
| `bun run sandbox:build` | Rebuild the sandbox image after editing its Dockerfile |

The sandbox image is built locally and is not published anywhere, so it has to
be built on each machine — `setup` does it, and `SANDBOX_IMAGE` overrides the
tag if you want a different one.

Models are served by an OpenAI-compatible gateway. Point the API at yours in
`apps/api/.env`:

```bash
CUSTOM_BASE_URL=http://your-gateway:9999/v1   # defaults to the LAN gateway
CUSTOM_API_KEY=sk-...                          # required; models show as
                                               # unavailable without it
```

A model with no key resolves to an `error` event on the SSE stream, which the
console renders inline — the run is never silently swapped for another model.

## What it demonstrates

- **Parallel agents** – every question spawns its own agent on its own SSE
  connection. The sidebar lists them all with live status; selecting one shows
  its transcript.
- **One agent, selectable models** – resources add capabilities automatically;
  users do not have to choose a specialised harness first.
- **Tool-calling loop** – the agent streams text, calls tools, feeds results back
  in, and iterates until it answers (or hits the harness max-iterations).
- **The loop rail** – every reasoning pass, tool call, and result lands as a node
  on a single vertical rail, in the order the agent produced it.
- **Trace** – the raw step/timing lines the runtime emitted, per agent.
- **Runs survive a refresh** – every run is written to SQLite and the board is
  rebuilt from it on load.

## Tools

| Tool             | What it does                                       |
| ---------------- | -------------------------------------------------- |
| `calculator`     | Evaluate an arithmetic expression                  |
| `get_current_time` | Current UTC time (ISO 8601)                     |
| `get_weather`    | Deterministic mock forecast for a city             |
| `random_number`  | Random integer in a range                          |
| `fetch_url`      | Fetch a URL and return the first ~1000 chars       |
| `echo`           | Echo text back                                     |
| `search_schema`  | Find tables/columns by keyword across connected databases |
| `describe_table` | Columns, types, primary key, foreign keys, indexes for one table |
| `run_query`      | Run one read-only SELECT against a connected database |

## Architecture

```
web (React) ── POST /api/chat (SSE) ──> api (Hono)
                                          └─ runAgent(harness, model)
                                             └─ chatOnce(model)      → stream
                                             └─ runTool(name, args)  → result
```

The API is layered: a request enters through a **route**, a **controller**
handles HTTP in/out, a **service** holds the logic, and a **repository** is the
only thing that touches the database.

```
apps/api/src
  index.ts                    boot: ensure schema, export the server
  app.ts                      Hono instance + middleware + route mounting
  config/env.ts               every env var, read once
  routes/                     URL → controller
  controllers/                HTTP in/out only (meta, chat, conversation)
  services/                   logic, one directory per domain:
    agent/                    the run itself — pi runtime, provider, models,
                              transcript, environment prompt
    context/                  token accounting: window size and compaction
    documents/                the searchable corpus: ingest, extract, chunk,
                              search, and the search_docs tool
    media/                    images in and out: storage, generation, and
                              read_image
    mcp/                      MCP clients, allowlist, tool catalog and search
    db/                       connected databases: introspection, SQL guard
    sandbox/                  per-workspace containers
    playbook/                 what a workspace has learned from its own runs
    memory/  skills/  connectors/
  repositories/               DB access (conversation, memory)
  models/schema.ts            Drizzle tables + row types
  catalog/                    static catalogs: harnesses, llm-models, tools
  db/client.ts                SQLite connection + ensureSchema
  middleware/                 request logging
  lib/                        logger, SSE helpers
  types/                      shared DTOs (chat wire types, agent events)
```

Flow in `services/agent.service.ts`:

1. Prepend the harness **system prompt** to the conversation.
2. Ask the model (streamed, OpenAI-compatible) for text **and/or tool calls**.
3. If there are tool calls, execute them and append assistant + tool messages.
4. Repeat until the model answers without tools, or max iterations is hit.

### Endpoints

| Method | Path                     | What it does                              |
| ------ | ------------------------ | ----------------------------------------- |
| GET    | `/api/meta`              | Harness + model catalog, with readiness    |
| POST   | `/api/chat`              | Run one agent turn, streamed over SSE      |
| GET    | `/api/conversations`     | List a workspace's stored conversations    |
| GET    | `/api/conversations/:id` | One conversation + its messages and traces |
| DELETE | `/api/conversations/:id` | Delete a conversation (cascades)           |
| GET    | `/api/workspaces`        | List the user's workspaces                 |
| POST   | `/api/workspaces`        | Create one                                 |
| PATCH  | `/api/workspaces/:id`    | Rename one                                 |
| DELETE | `/api/workspaces/:id`    | Delete one and everything it holds         |
| GET    | `/api/mcp`               | A workspace's MCP servers + cached capabilities |
| POST   | `/api/mcp`               | Add a server and probe it                  |
| POST   | `/api/mcp/:id/refresh`   | Reconnect and re-read what it offers       |
| PATCH  | `/api/mcp/:id`           | Enable or disable it                       |
| DELETE | `/api/mcp/:id`           | Remove it and its cached capabilities      |

Every scoped endpoint takes `?userId=&workspaceId=`. An absent, unknown, or
unowned `workspaceId` falls back to the user's first workspace rather than
erroring — a client may be holding an id that was deleted in another tab.

### Persistence

Every run is stored. `chat.controller.ts` creates a conversation up front and
emits its id as the first SSE frame, so the client can bind its agent to the row
immediately. `TranscriptRecorder` then folds the event stream — hundreds of text
deltas — into a compact transcript, written once when the run settles (finish,
error, or the client hanging up mid-flight).

On load, the console lists this browser's conversations and rebuilds them as
agents. Transcripts are fetched lazily, the first time you open one. Removing an
agent deletes its conversation, and messages + traces cascade with it.

#### Workspaces

A workspace is the container for one body of work: its agents, uploaded
documents, database connections, and the sandbox directory its agents write to.
Everything the console shows belongs to the selected workspace, chosen in the
switcher under the wordmark.

Users own workspaces; **nothing else is scoped by user**. A workspace's sandbox
lives at `SANDBOX_ROOT/<workspaceId>` and its container is
`pixelspace-<workspaceId>`, so two workspaces never share a filesystem. The browser
still generates a `userId` and keeps it in localStorage — it is the ownership
root, and the only thing it now selects is which workspaces you can reach.

`workspaceRegistry.resolve(userId, requested)` is the single gate: it is the one
place a client-supplied workspace id is checked against ownership, and every
repository below it trusts the id it is handed. Adding a second path that
accepts a workspace id without going through it would bypass the only check
there is.

Existing data was moved into a `Default` workspace per user on first boot after
the upgrade, and the pre-workspace `user_id` column was then dropped from each
scoped table. The backfill is idempotent and still runs, so a database from
before the change can be opened at any time. Removing a workspace deletes its
rows — including the FTS mirrors, which no foreign key reaches — but
deliberately leaves its sandbox directory on disk.

#### Run status

`conversations.status` records how a run ended, and the sidebar shows it next to
each agent.

| Status    | Means                                              | Sidebar        |
| --------- | -------------------------------------------------- | -------------- |
| `running` | in flight (a row left here means the server died)   | pulsing dot    |
| `done`    | finished and produced output                        | hollow ring    |
| `stopped` | you hit Stop, or the client hung up mid-run         | dashed ring    |
| `error`   | the run reported a failure, or produced no output   | alert icon     |

Two cases are easy to get wrong, so they are handled explicitly. The agent loop
reports failures as an `error` **event** rather than throwing, so status is
derived from the recorded stream, not from a `try/catch`. And a run can finish
without any reported failure yet produce nothing at all — an unreachable gateway
or an unknown model name both look like that — so an empty run is recorded as an
error rather than a success.

### Sandboxed workspaces

The agent's `bash` / `read` / `write` / `edit` tools run inside a per-workspace
Docker container, not on the API host. The workspace's directory lives at
`SANDBOX_ROOT/<workspaceId>` and is bind-mounted into the container **at the
same absolute path**, so host and container share one path namespace and no
translation is ever needed.

This is also why "workspace" means one thing here: the sandbox directory *is*
the workspace's file storage, rather than a second, unrelated use of the word.

This is the default, and deliberately so. Under `SANDBOX_BACKEND=node` the same
tools run directly on the API host as whoever started the server: the working
directory is a starting point, not a boundary, so the agent can read anything
that user can — `~/.ssh`, other repositories, `apps/api/.env`, and the server
process's own environment. Since uploaded documents put untrusted text into the
model's context, a prompt-injected PDF would inherit all of it. Use `node` only
as a trusted operator on a machine you would not mind losing.

Containers are started on demand, reused while warm, and removed after
`SANDBOX_IDLE_MS` of inactivity by a reaper started at boot. **Workspace
directories are never deleted** — that is the whole point: a file an agent
writes today is still there for a different agent next week. Deleting a
workspace in the console clears its rows and leaves its directory alone.

| Var | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_BACKEND` | `docker` | `docker` (per-workspace container, default) or `node` (API host — unsandboxed) |
| `SANDBOX_IMAGE` | `node:22-bookworm-slim` | Image the agent works inside |
| `SANDBOX_ROOT` | `~/pixelspace-workspaces` | Where workspace directories live on the host |
| `SANDBOX_IDLE_MS` | `300000` | Remove a container after this much idle time |

Needs a running Docker daemon — `bun run dev` is enough, no env var required.
With Docker down, runs fail with a clear message rather than silently falling
back to the host; a silent fallback would hand the model a shell on the API
server, which is exactly what this default exists to prevent.

`DockerExecutionEnv` extends pi's `NodeExecutionEnv` and overrides only `exec`.
Swapping in a hosted backend (E2B, Fly) means one more class against the same
`ExecutionEnv` interface; nothing else changes.

Prove the persistence mechanic independently of the app:

```bash
cd apps/api && bun scripts/sandbox-persistence-check.ts
```

### Connected databases

The agent can query a workspace's connected PostgreSQL databases read-only,
without switching modes or harnesses. A connection is configured with an explicit engine, host, port,
database, username, password, and SSL policy. Passwords and private TLS options
are encrypted with `CONNECTION_SECRET`; full URLs are neither stored nor
returned. The connector introspects once into a schema snapshot the agent
searches. Connection names are unique per workspace, so two workspaces may each
have a `prod` without the agent being unable to tell them apart.

Database egress is allowlisted by `DATABASE_ALLOWED_CIDRS` (RFC1918 and IPv6
ULA by default). Every DNS answer must be allowed, and the driver connects to
the validated literal address so a second resolution cannot redirect it.
Loopback, link-local, cloud metadata, Unix sockets, and multicast are denied.

```bash
CONNECTION_SECRET=$(openssl rand -base64 32)   # required, else connections are refused
```

The agent works schema-first: `search_schema` finds candidate tables,
`describe_table` returns exact columns and foreign keys, and only then does
`run_query` execute a SELECT. Full schema is never pre-loaded — the system prompt
carries table names only, so a thousand-table database costs the same as a
ten-table one.

Read-only is enforced in four layers:

| Layer | Mechanism |
| --- | --- |
| Operator | Point the connection at a `GRANT SELECT`-only role |
| Statement | Only `SELECT` / `WITH` / `EXPLAIN`; write keywords rejected anywhere in the statement |
| Transaction | `BEGIN TRANSACTION READ ONLY`, always rolled back |
| Budget | 10s `statement_timeout`, 100-row cap, 50KB result cap |

The statement guard exists to give the model a correctable error message. The
transaction is the actual guarantee — Postgres allows data-modifying CTEs, so
`WITH x AS (DELETE ... RETURNING *) SELECT * FROM x` begins with `WITH` and
writes, and only the transaction catches it unconditionally.

The model never receives a connection string. Tools take a connection name and
the credential is resolved server-side, so a prompt-injected document cannot ask
the agent to reveal it.

Prove the guarantee against your own server:

```bash
cd apps/api && \
  DB_CHECK_HOST=10.0.0.10 DB_CHECK_DATABASE=app DB_CHECK_USERNAME=reader \
  DB_CHECK_PASSWORD=... bun scripts/db-connector-check.ts
```

Database create, update, test, refresh, and delete operations all resolve the
authenticated caller's workspace before accessing a connection. Encryption
protects credentials at rest; the proxy/firewall boundary described below is
what makes the caller identity trustworthy.

### MCP servers

A workspace can connect Model Context Protocol servers, and the agent gains
their tools, resources, and prompts without a code change here. Servers are
added in the console's **MCP** tab, over either transport:

| Transport | Configured with | Reached by |
| --- | --- | --- |
| `http` | URL + optional `Authorization` header | Streamable HTTP, falling back to SSE |
| `stdio` | Command + args + env | A child process on the API host |

Credentials — headers and env vars — are encrypted with `CONNECTION_SECRET`,
the same key the database connector uses, and are never selected into a
response, a prompt, or a transcript.

What the agent gets:

- **Tools** as `<server>__<tool>`, so two servers can both expose `search`.
- **Resources** through two flat tools, `mcp_list_resources` and
  `mcp_read_resource` — one tool per resource would put an unbounded list in
  every system prompt.
- **Prompts** as pi prompt templates. Argument-free ones are pre-rendered; the
  rest map positional placeholders onto named arguments via `mcp_get_prompt`.

Like database tools, MCP capabilities follow the resources attached to the
workspace: adding a server is the opt-in, with no separate harness selection.

Connections last exactly one run and are closed in the same `finally` that
cleans up the execution environment, so a stdio server's child process cannot
outlive the run that spawned it. A server that will not connect is recorded
with its reason, skipped, and the remaining servers still contribute.

stdio commands are checked against an allowlist — `npx`, `uvx`, `node`,
`python`, `python3`, `bun`, `deno` — as a bare command name, with no shell and
no inline-code flags (`node -e`, `python -c`). The child is given the SDK's
safe-to-inherit environment plus what you configured, not the API process's
own, which holds model keys and `CONNECTION_SECRET`.

The allowlist says what is *permitted*; the launcher still has to exist where
the API runs. The deployed image ships `npx`, `uvx`, `node`, and `bun` — the
`apps/api/Dockerfile` copies them in for exactly this reason. `python` and
`python3` are permitted but absent; use `uvx`, which brings its own.

First contact with a new stdio server is a package download, not a handshake,
so stdio gets a 180s connect budget against HTTP's 10s. The download is cached
in the `mcp-cache` volume, so it is paid once, not once per deploy.

**Two things the allowlist does not do.** It narrows the entry point; it does
not isolate what runs — an allowlisted launcher can still fetch and execute an
arbitrary package, and it runs on the API host rather than inside the workspace
sandbox. And MCP tool results are model-visible by definition, so a malicious
server can attempt prompt injection through them. Connect servers you trust.

### Deploying

Two containers, one published port:

```bash
cp .env.example .env      # fill in CONNECTION_SECRET and model keys
bun run sandbox:build     # the agent's sandbox image
docker compose up -d --build
```

The console is then on `http://localhost:8080`. `web` is Caddy serving the
built console and proxying `/api` to `api` over the compose network — the API
has no host port, because it has no authentication either.

Ask Claude Code to **"deploy"** and the `deploy` skill in `.claude/skills/`
runs this: tests, build, start, then verifies `/api/meta` answers through the
proxy.

The commands above remain the source-deployment path for the internal host.
New single-host installations should use `./install.sh`, which discovers the
host identity and Docker group, keeps state outside the checkout, defaults to
loopback-only exposure, and provides explicit lifecycle commands.

**Docker-out-of-Docker.** The API reaches the host daemon through a
bind-mounted `/var/run/docker.sock` and starts each workspace's sandbox as a
*sibling* container. That is why three paths in `docker-compose.yml` are
mounted at identical host and container paths: `docker run -v <p>:<p>` is
resolved by the daemon on the host, so a path the API container names has to
mean the same thing there.

| `.env` key | Why it exists |
| --- | --- |
| `REPO_ROOT` | Absolute path to this checkout; skills are mounted from it at the same path on both sides |
| `SANDBOX_ROOT` | Workspace directories, mounted identically for the same reason |
| `HOST_UID` / `HOST_GID` | The API runs as your uid, so files it writes into those mounts belong to you |
| `DOCKER_GID` | The host `docker` group, which is what makes the mounted socket readable |
| `WEB_PORT` | The only published port |

Socket access is root-equivalent on the host — a deliberate trade for real
per-workspace isolation. The alternative, `SANDBOX_BACKEND=node`, would put the
agent's shell inside the API container with the model keys and
`CONNECTION_SECRET`.

SQLite is bind-mounted from `apps/api/data`, so a rebuild keeps conversations,
workspaces, documents, and MCP servers. Rolling code back does not roll data
back.

**Not production.** No authentication, no TLS, no zero-downtime replace, no
automatic backup. Do not publish `WEB_PORT` beyond a trusted network.

### Adding a model

Add an entry to `MODELS` in `apps/api/src/catalog/llm-models.ts` (OpenAI-compatible
base URL + env var for the key). The model picker and ready state update
automatically.

### Adding a tool

Add an entry to `TOOLS` in `apps/api/src/catalog/tools.ts` with a name, description,
JSON-schema `parameters`, and a `run()` (string or async string). No wiring
needed — the schema is auto-exposed to the model and the result is shown in the
UI.

## Scripts

| Command               | Where     | What it does              |
| --------------------- | --------- | ------------------------- |
| `bun run dev`         | root      | Run API + web together    |
| `bun run dev:api`     | root      | API only (`bun --watch`)  |
| `bun run dev:web`     | root      | Web only (Vite)           |
| `bun run build`       | `apps/web`| Type-check + production build |
| `bun run lint`        | `apps/web`| oxlint                    |
| `bunx tsc --noEmit`   | `apps/api`| Type-check the API        |
