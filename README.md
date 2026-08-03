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
# install deps (from apps/web so bun resolves all workspaces)
bun install

# run both servers
bun run dev            # API on :4000, web on :5173
# or in separate terminals:
bun run dev:api
bun run dev:web
```

Open http://localhost:5173.

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
| GET    | `/api/conversations`     | List a user's stored conversations         |
| GET    | `/api/conversations/:id` | One conversation + its messages and traces |
| DELETE | `/api/conversations/:id` | Delete a conversation (cascades)           |

### Persistence

Every run is stored. `chat.controller.ts` creates a conversation up front and
emits its id as the first SSE frame, so the client can bind its agent to the row
immediately. `TranscriptRecorder` then folds the event stream — hundreds of text
deltas — into a compact transcript, written once when the run settles (finish,
error, or the client hanging up mid-flight).

On load, the console lists this browser's conversations and rebuilds them as
agents. Transcripts are fetched lazily, the first time you open one. Removing an
agent deletes its conversation, and messages + traces cascade with it.

Conversations are scoped by a `userId` the browser generates and keeps in
localStorage, so the `users -> conversations -> messages/traces` chain in the
schema is actually exercised.

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

With `SANDBOX_BACKEND=docker`, the agent's `bash` / `read` / `write` / `edit`
tools run inside a per-user Docker container instead of on the API host. The
user's workspace lives at `SANDBOX_ROOT/<userId>` and is bind-mounted into the
container **at the same absolute path**, so host and container share one path
namespace and no translation is ever needed.

Containers are started on demand, reused while warm, and removed after
`SANDBOX_IDLE_MS` of inactivity by a reaper started at boot. **Workspaces are
never deleted** — that is the whole point: a file an agent writes today is still
there for a different agent next week.

| Var | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_BACKEND` | `node` | `node` (API host) or `docker` (per-user container) |
| `SANDBOX_IMAGE` | `node:22-bookworm-slim` | Image the agent works inside |
| `SANDBOX_ROOT` | `~/salurai-workspaces` | Where workspaces live on the host |
| `SANDBOX_IDLE_MS` | `300000` | Remove a container after this much idle time |

```bash
cd apps/api && SANDBOX_BACKEND=docker bun run dev
```

Needs a running Docker daemon. With `SANDBOX_BACKEND=docker` and Docker down,
runs fail with a clear message rather than silently falling back to the host —
a silent fallback would hand the model a shell on the API server.

`DockerExecutionEnv` extends pi's `NodeExecutionEnv` and overrides only `exec`.
Swapping in a hosted backend (E2B, Fly) means one more class against the same
`ExecutionEnv` interface; nothing else changes.

Prove the persistence mechanic independently of the app:

```bash
cd apps/api && bun scripts/sandbox-persistence-check.ts
```

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
