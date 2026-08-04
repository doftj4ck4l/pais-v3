# SalurAI

An agent console that pairs **agent harnesses** (how an agent reasons and uses
tools) with **models** (which backend powers the loop) and runs a **real
tool-calling agent loop** you can watch step by step, over a **context layer**
built from your own documents.

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
- **Harness × model matrix** – pick a harness and a model; each combination runs
  the same loop.
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
| `search_schema`  | Find tables/columns by keyword across connected databases (`db-analyst` harness only) |
| `describe_table` | Columns, types, primary key, foreign keys, indexes for one table (`db-analyst` harness only) |
| `run_query`      | Run one read-only SELECT against a connected database (`db-analyst` harness only) |

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
  services/                   logic: agent loop, pi runtime, provider, models,
                              memory tools, skills
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
`salurai-<workspaceId>`, so two workspaces never share a filesystem. The browser
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
| `SANDBOX_ROOT` | `~/salurai-workspaces` | Where workspace directories live on the host |
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

The `db-analyst` harness can query a workspace's PostgreSQL databases,
read-only. A connection is added in the console, encrypted with
`CONNECTION_SECRET`, and introspected once into a schema snapshot the agent
searches. Connection names are unique per workspace, so two workspaces may each
have a `prod` without the agent being unable to tell them apart.

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
cd apps/api && DB_CHECK_URL=postgres://... bun scripts/db-connector-check.ts
```

**Not yet safe for production data.** Connections are stored against a `userId`
the browser generates, with no authentication — anyone who forges one can use
that user's connections. Encryption protects `app.db` at rest, not the API.

### Adding a model

Add an entry to `MODELS` in `apps/api/src/catalog/llm-models.ts` (OpenAI-compatible
base URL + env var for the key). The model picker and ready state update
automatically.

### Adding a harness

Add an entry to `HARNESSES` in `apps/api/src/catalog/harnesses.ts` (a system
prompt and a `maxIterations` budget). The only observable difference is the
prompt, which is the point of the POC.

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
