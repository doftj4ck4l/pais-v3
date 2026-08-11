# Working in this repo

Orientation for an agent. The README explains what Salur *is* and how to run it;
this file records what is easy to get wrong. Read the README first for
architecture, then this for the traps.

Two parts of the README have rotted and will mislead you: the endpoints table
still says every scoped endpoint takes `?userId=&workspaceId=` (identity now
comes from a header — see *Who the caller is*), and the four-step agent loop
under "Flow in `services/agent.service.ts`" describes a driver no shipped
harness uses (see *Two agent drivers*).

## Toolchain

Bun, not npm. `bun test`, `bun run build`, `bunx tsc`. Node is only present to
bootstrap Bun.

```bash
cd apps/api && bun test                          # 457 pass, 7 fail
cd apps/api && bun test src/services/mcp         # one directory
cd apps/api && bun test -t "reapIdle"            # one test by name
cd apps/api && bunx tsc --noEmit -p tsconfig.json
cd apps/web && bun run build                     # tsc -b && vite build
cd apps/web && bun run lint                      # oxlint, no config file
```

`apps/web` has no test suite; `bun run build` is its check, and the `tsc -b`
half of it is what catches real breakage.

**The 7 failures are the baseline, not a regression.** They are the
`sandbox.service` / `docker.ts` / `docker-execution-env.ts` tests, and they fail
whenever the Docker daemon is unreachable from the test process. Compare against
7 before assuming you broke something; anything in that list is pre-existing,
anything outside it is yours. CI excludes those three files by name rather than
tolerating failures, so any *other* red test stops a deploy.

## Two agent drivers

`Harness.driver` is `"prompt" | "pi"`, and **both shipped harnesses are `"pi"`**.
So `runAgent` in `agent.service.ts` forwards to `runPiAgent` before it reaches
its own loop, and that loop is unreachable from the catalog. Read
`pi.service.ts` (the real engine, ~930 lines) for anything about how a run
actually behaves; editing the loop in `agent.service.ts` changes nothing you can
observe.

The model's tool list is assembled in one place there, from six sources — not
just `catalog/tools.ts` as the README's "Adding a tool" implies:

| Source | Gate |
| --- | --- |
| pi built-ins (`bash`, `read`, `write`, `edit`) | always |
| `catalog/tools.ts` | always |
| `memory.service` (`remember` / `recall`) | always |
| `context-tools` (document search) | always |
| `image-tools` | `OPENROUTER_API_KEY` **and** RustFS configured |
| `db-tools` | `harness.tools` includes `"db"` |
| `mcp-tools` | a workspace has servers — deliberately *not* harness-gated |

MCP tools are also deferred: only previously-used ones start active, and
`search_tools` widens the set mid-run. That is why the advertised count and the
count the model was shown differ in the slots panel, and why both are emitted.

## The three execution contexts

The single most misread thing here. A tool call in the transcript could be
running in any of these:

| Where | What runs there |
| --- | --- |
| **API process** | MCP tools (stdio child or HTTP fetch), `calculator`, `remember`, `search_docs` |
| **Sandbox container** (`salurai-<workspaceId>`) | `bash`, `read`, `write`, `edit`, `call_skill`, via `docker exec` |
| **Model provider** | the turn itself |

**MCP never touches the sandbox.** stdio MCP servers are child processes of the
API, which is why `apps/api/Dockerfile` installs `npx`, `uvx` and `node` — the
allowlist in `services/mcp/allowlist.ts` says what is *permitted*, but the
launcher still has to exist where the API runs.

`sandbox.acquire` runs before the tool list is built, unconditionally when
`SANDBOX_BACKEND=docker`. A run that only calls MCP tools still pays for it.

## Docker-out-of-Docker

The deployed API reaches the host daemon through a bind-mounted
`/var/run/docker.sock` and starts sandboxes as *sibling* containers. Three paths
in `docker-compose.yml` are mounted at **identical host and container paths**,
because `docker run -v <p>:<p>` is resolved by the daemon on the host: a path the
API container names has to mean the same thing there. Changing `SANDBOX_ROOT` or
`REPO_ROOT` without preserving that breaks sandboxes in a way that looks like a
missing directory.

## Environment files

Two, and they are not interchangeable:

- **`.env` (root)** — deployment config: `REPO_ROOT`, `SANDBOX_ROOT`, `HOST_UID`,
  `DOCKER_GID`, `WEB_PORT`. Read by docker-compose.
- **`apps/api/.env`** — application secrets: `CONNECTION_SECRET`, model API keys.
  Read by `bun dev` **and** by compose (listed second in `env_file`, so it wins).

Put an API key in the wrong one and it works in dev and is silently absent in
the deployment.

## Who the caller is

`userId` comes from the `AUTH_USER_HEADER` header (`x-authentik-uid`) and from
nowhere else. It used to come from `?userId=`, which let any caller name any
tenant; the ownership check in the workspace registry was sound, it was just
being asked the wrong question.

Two halves make that header trustworthy, and neither works alone:

- `AUTH_MODE=proxy` refuses a request carrying no identity, rather than falling
  back to a shared account. `dev` restores the fallback for `bun dev`.
- The deploy host drops traffic to `WEB_PORT` from anywhere but the proxy. **If
  that port is ever published more widely, the header is forgeable and the
  isolation is gone** — the firewall rule is part of this control, not separate.

`/api/meta` is deliberately open: it carries no tenant data and is what the
container healthcheck calls. Gate it and the container reports unhealthy.

Controllers must call `currentUserId(c)`. Reading a user id off the query string
or request body reintroduces the hole.

## Migrations

`applySchema` uses `CREATE TABLE IF NOT EXISTS`, which does nothing for a table
that already exists. **Adding a column to an existing table needs an explicit
`ALTER TABLE`** next to the ones already in `db/client.ts`. Miss it and Drizzle
selects a column SQLite does not have, and the API returns the column *name* as
the value rather than erroring.

## Context accounting

`estimateHistoryTokens` measures the chat history and nothing else — not the
system prompt, not the tool schemas. With an MCP server advertising 151 tools
that is ~36k tokens invisible to it, which is why the meter read 1% while the
window was 30% full.

The honest number is `usage.input + usage.cacheRead` from the provider, recorded
as a `context.usage` span and read back by `lastContextTokens()` for the next
request. **`usage.input` alone is not it** — a cached prompt prefix still occupies
the window, and a gateway that caches tool schemas reports 160 where the truth is
36,512.

Compaction only helps when *history* is what is large. When tool schemas are the
occupancy, `planCompaction` correctly returns null; summarising two messages
would cost a model call and reclaim nothing.

## What a stdio MCP child inherits

`connectStdio` gives the child an explicit **environment** and an explicit
**working directory**. Both are the same decision and only the first was
obvious.

A working directory is readable configuration to anything that looks for a
dotfile in it. `fastmcp` constructs a pydantic `Settings()` at *import* time,
which reads `.env` relative to cwd — so a child left in the API's directory was
being handed `apps/api/.env` as its own configuration. `stdioCwd()` in
`services/mcp/client.ts` puts each server in an empty directory of its own
instead.

What surfaced was a crash, not a leak, and only by luck: in the deployed image
that file is mode 600 root:root while the API runs as uid 1000, so
`uvx plane-mcp-server stdio` died on import with `PermissionError: [Errno 13]
Permission denied: '.env'`, which the transport reports as the uninformative
`MCP error -32000: Connection closed`. Under `bun dev` the same file is readable
by the same user and the secrets would have loaded in silence.

**`.dockerignore` patterns are anchored at the context root unless they start
with `**/`.** A bare `.env` excluded the root file only, and `COPY apps/api`
carried `apps/api/.env` into the image at `/app/apps/api/.env` — byte-identical
to the host's secrets file, under a comment promising secrets never enter a
layer. Any new secret file needs the `**/` form.

When an MCP server reports "Connection closed", the cause is in `error_detail`
on its `mcp_servers` row, not in `error`.

## MCP result size

Bounded in two places, and both are load-bearing:

- `RESULT_CHAR_CAP` (40k) per call
- `RUN_CHAR_BUDGET` (120k) per run

The per-call cap alone was not enough: six parallel `read_file` calls, each
individually under the cap, still carried 240k characters into one turn. Every
result goes through `toolResult()`, so a tool added later cannot forget to bound
its output.

## Image generation

`generate_image` calls OpenRouter, not the gateway the chat models come from,
and OpenRouter has **no separate image endpoint**. Generation is
`/chat/completions` with `modalities: ["image", "text"]`. Three things about the
response are easy to get wrong, and all three were found by calling it:

- `message.content` is **null**. The image is on `message.images[]` as a data
  URI. Reading `content` and finding nothing looks exactly like a failure.
- **Do not set `max_tokens`.** Reasoning tokens come out of the same budget, so
  a small cap returns `finish_reason: "length"` with no image and no error. A
  20-token cap spent 18 on reasoning and returned nothing.
- The `image_output` price in `/api/v1/models` is **per token, not per image**.
  One 1408x768 image billed $0.0336–$0.0673 — roughly 1,500x a text call, from
  a tool any prompt can reach.

The bytes never enter SQLite or the transcript. They go to the RustFS bucket and
the tool returns a `/api/images/<id>` URL, because one base64 image is 30k–2.5M
characters: it would blow `RESULT_CHAR_CAP` alone and then be replayed to the
model every following turn, for a picture the chat model cannot see anyway. The
tool description tells the model to embed that URL as markdown — the console
renders assistant text through `marked`, and without the instruction the model
says "I've generated it" and shows nothing.

## RustFS

S3-compatible object storage, unpublished like `api` — only the API talks to it,
and it re-serves objects so a link in a transcript never expires.

`Bun.S3Client` covers get/put/delete but has **no CreateBucket**, so that one
request is SigV4-signed by hand in `media.service.ts` rather than pulling in
`@aws-sdk/client-s3` for a single call. Re-creating an existing bucket answers
**200 on RustFS where AWS answers 409**; both are treated as success.

Do **not** add `user: "${HOST_UID}:${HOST_GID}"` to the rustfs service the way
`api` has it. `api` needs it for bind mounts the host user must own; rustfs owns
a named volume nothing opens by path, and under that override the image dies on
startup with `Local disk initialization failed ... Permission denied (os error
13)` because `/data` and `/logs` belong to its own `rustfs` user.

## pi's two event channels

`AgentHarness` delivers events through **two separate channels**, and registering
on the wrong one fails silently:

- `subscribe(listener)` — observation. `turn_end`, `tool_execution_*`,
  `after_provider_response`, `retry_*`.
- `on(type, handler)` — hooks that can *change* the request, so they return a
  value. `before_provider_request`.

`before_provider_request` and `after_provider_response` are the two halves of one
round trip and they arrive on different channels. See the comment in
`pi.service.ts`.

Provider-level retries are **not observable** at 0.83.0. pi-ai defines
`RetryCallbacks` but the harness wires them only to compaction and branch
summarisation, never to the turn. Do not add a field that claims to count them.
Upstream issue: earendil-works/pi#7649.

## pi is being rewritten

We pin `^0.83.0`, which is the latest published. Upstream `main` has replaced the
harness entirely (`AgentHarness implements AgentLane`, durable runs, lanes);
`AgentHarnessOwnEvent` and `InMemorySessionStorage` do not exist there. Their
design doc is `packages/agent/docs/harness-v2.md`, and as of August 2026 it is 40
work packages with none done, with execution methods rejecting as
`HarnessNotImplemented`.

Nothing to do now. When it publishes, `pi.service.ts` needs a migration.
`@earendil-works/pi-ai` (`createModels`, `createProvider`, the API adapters) is
**not** part of the rewrite and is safe to build on.

## Web routing

TanStack Router, file-based, routes in `apps/web/src/routes/`. `routeTree.gen.ts`
is generated by the Vite plugin but **committed on purpose**: `build` runs
`tsc -b` before Vite, so a fresh clone without it fails typecheck before the
plugin ever runs.

Providers that must outlive navigation (`TooltipProvider`, `WorkspaceContext`)
belong in `__root.tsx`, not in a route.

## Deploying

Two targets, and they are not the same machine.

**This host.** Say "deploy" and use `.claude/skills/deploy/SKILL.md`. It runs
tests, builds, starts, and verifies `/api/meta` through the proxy. `docker
compose up -d --build` — without `--build`, "deployed" silently means "restarted
the old code".

**Pushing to `main` deploys too.** `.forgejo/workflows/deploy.yml` fires on every
push to `main`: it tests, rsyncs the tree to the deploy host, and rebuilds there.
Merging is a release, so treat a merge to `main` as one. The rsync runs
`--delete` but excludes `.env`, `apps/api/.env` and `apps/api/data` from transfer
*and* from deletion — that is the only thing standing between a deploy and the
live SQLite database.

## Conventions

Comments explain **why**, not what, and are written where the reasoning is
non-obvious — a cap that exists because of a specific failure says which one.
Repository modules own their tables exclusively. Secrets are selected by explicit
column list so a new field cannot leak by being added. Tests run against a real
in-memory SQLite built from `applySchema`, never a mock.
