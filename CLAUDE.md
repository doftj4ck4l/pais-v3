# Working in this repo

Orientation for an agent. The README explains what Pixelspace *is* and how to run it;
this file records what is easy to get wrong. Read the README first for
architecture, then this for the traps.

Two parts of the README have rotted and will mislead you: the endpoints table
still says every scoped endpoint takes `?userId=&workspaceId=` (identity now
comes from a header — see *Who the caller is*), and the four-step agent loop
under "Flow in `services/agent.service.ts`" describes code that no longer exists
(see *Where a run actually happens*).

## Toolchain

Bun, not npm. `bun test`, `bun run build`, `bunx tsc`. Node is only present to
bootstrap Bun.

```bash
cd apps/api && bun test                          # 476 pass, 7 fail
cd apps/api && bun test src/services/mcp         # one directory
cd apps/api && bun test -t "reapIdle"            # one test by name
cd apps/api && bunx tsc --noEmit -p tsconfig.json
cd apps/web && bun test                          # web unit tests
cd apps/web && bun run build                     # tsc -b && vite build
cd apps/web && bun run lint                      # oxlint, no config file
```

For `apps/web`, run both `bun test` and `bun run build`; the `tsc -b` half of the
build catches type errors that the unit tests do not.

**The 7 failures are the baseline, not a regression.** They are the
`sandbox.service` / `docker.ts` / `docker-execution-env.ts` tests, and they fail
whenever the Docker daemon is unreachable from the test process. Compare against
7 before assuming you broke something; anything in that list is pre-existing,
anything outside it is yours. CI excludes those three files by name rather than
tolerating failures, so any *other* red test stops a deploy.

**A green run here is not a green run in CI.** CI is a fresh checkout, and
`apps/api/data/` is not in git. A test that reaches the `db` singleton gets an
empty database there and a fully migrated one on your machine, so a suite that
passes locally can fail on a schema your working database happened to already
have. Two things follow:

- Under `bun test`, an unset `DB_PATH` resolves to a throwaway file rather than
  `data/app.db` — see `db/client.ts`. Tests cannot read or write what you last
  used `bun dev` on, and cannot borrow its schema either.
- An app-level test that drives a route touching storage has to call
  `ensureSchema()` in `beforeAll` after pointing `DB_PATH` somewhere, the way
  `app.test.ts`, `profile.integration.test.ts` and `onboarding.integration.test.ts`
  do. Adding a database read to a route that had none is what turns a wiring
  test into one that needs this.

Before claiming a suite is green, run what CI runs:

```bash
cd apps/api && find src -name '*.test.ts' \
  ! -name 'docker.test.ts' ! -name 'docker-execution-env.test.ts' \
  ! -name 'sandbox.service.test.ts' -print0 | xargs -0 bun test   # 476 pass, 0 fail
```

`bun test` alone shares one process across files, so the first file to import
`db/client` fixes `DB_PATH` for every file after it. That makes ordering part
of the result: run a file on its own before trusting that it passes.

## Where a run actually happens

`services/agent/pi.service.ts` (~1030 lines). Not `agent.service.ts` beside it,
which is a 38-line adapter turning a catalog harness into `runPiAgent` arguments
and nothing else — and not the README's four-step loop under "Flow in
`services/agent.service.ts`", which describes a second loop that used to live
there.

`services/` is one directory per domain. Two of those names are close enough to
mislead: **`context/` is token accounting** — how big the window is and when to
compact — while **`documents/` is the searchable corpus** and owns the
`search_docs` tool. `documents/document-tools.ts` was called `context-tools.ts`
for exactly as long as that was confusing.

That loop was reached when `harness.driver` was anything but `"pi"`. Every
harness the catalog shipped was `"pi"`, so it was unreachable for as long as it
existed while still answering every search for where a turn is taken. It is
gone, along with `Harness.driver` and `Harness.maxIterations`, which existed
only to feed it. The catalog now exposes one harness; capabilities follow the
resources connected to the workspace rather than a separate harness choice.

The model's tool list is assembled in one place there, from seven sources — not
just `catalog/tools.ts` as the README's "Adding a tool" implies:

| Source | Gate |
| --- | --- |
| pi built-ins (`bash`, `read`, `write`, `edit`) | always |
| `catalog/tools.ts` | always |
| `memory.service` (`remember` / `recall`) | always |
| `documents/document-tools` (document search) | always |
| `image-tools` | `OPENROUTER_API_KEY` **and** RustFS configured |
| `vision-tools` (`read_image`) | the gateway is configured — *not* RustFS |
| `db-tools` | the workspace has a connected database with an inventory snapshot |
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
| **Sandbox container** (`pixelspace-<workspaceId>`) | `bash`, `read`, `write`, `edit`, `call_skill`, `fetch_url`, via `docker exec` |
| **Model provider** | the turn itself |

**MCP never touches the sandbox.** stdio MCP servers are child processes of the
API, which is why `apps/api/Dockerfile` installs `npx`, `uvx` and `node` — the
allowlist in `services/mcp/allowlist.ts` says what is *permitted*, but the
launcher still has to exist where the API runs.

`fetch_url` is a first-class wrapper around the sandboxed `web-fetch` skill.
The indirection is deliberate: an arbitrary URL must not be fetched with the
API process's filesystem and network identity. The script extracts useful HTML
before applying its output cap; returning the first bytes of raw markup caused
17 of 25 recent staging conversations to retry with the skill or rebuild the
same reader with `curl` and BeautifulSoup.

App-owned tools may return an `error:` string so the model can correct the
call. `pi.service` promotes that established result contract to a thrown tool
error at the harness boundary; otherwise pi records the call as successful and
the run ledger undercounts tool failures. Built-in and MCP tools are excluded
because their successful output can be arbitrary external text. On API startup,
any run and conversation still marked `running` is changed to `stopped`, since
the new process cannot still own work started by the previous one.

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

The source deployment uses two files, and they are not interchangeable:

- **`.env` (root)** — deployment config: `REPO_ROOT`, `SANDBOX_ROOT`, `HOST_UID`,
  `DOCKER_GID`, `WEB_PORT`. Read by docker-compose.
- **`apps/api/.env`** — application secrets: `CONNECTION_SECRET`, model API keys.
  Read by `bun dev` **and** by compose (listed second in `env_file`, so it wins).

Put an API key in the wrong one and it works in dev and is silently absent in
the deployment.

The on-prem operator is different. `scripts/pixelspace install` makes its
private deployment env the runtime source of truth and points
`PIXELSPACE_APP_ENV_FILE` at an empty private file so a checkout's
`apps/api/.env` cannot override it. When adopting an older deployment, the
operator preserves an existing application env path and includes that file in
backups. Never put either generated env inside an image; `.dockerignore` must
exclude both `.env` patterns and `app.env` at every depth.

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

On-prem installs may instead use `AUTH_MODE=local`. The operator bootstraps the
first email/password administrator after the stack becomes healthy. Passwords
are Argon2id hashes, browser session tokens are HttpOnly/SameSite cookies stored
only as SHA-256 digests, and password reset revokes all sessions. Local auth on
a non-loopback bind requires an HTTPS `PUBLIC_URL`; `AUTH_MODE=dev` remains a
loopback-only developer convenience. Never put a plaintext password in env,
Compose arguments, logs, or the database.

`/api/meta` is deliberately open: it carries no tenant data and is what the
container healthcheck calls. Gate it and the container reports unhealthy.

Controllers must call `currentUserId(c)`. Reading a user id off the query string
or request body reintroduces the hole.

## Migrations

`models/schema.ts` is the only place a table is described. The SQL is generated
from it:

```bash
cd apps/api
#  1. edit src/models/schema.ts
bunx drizzle-kit generate     # 2. writes drizzle/NNNN_*.sql
#  3. commit the generated file
```

Nothing applies them from the CLI. `ensureSchema` runs `migrate()` at boot, so
starting the API *is* migrating it — there is no second command to forget, and
none to run during a deploy.

**Do not hand-write DDL in `db/client.ts`.** It used to be several hundred lines
that had to agree with `models/schema.ts` by hand, and the way that failed was
silent: Drizzle would select a column SQLite did not have, and SQLite answers
that with the column *name* rather than an error, so the value looks plausible
everywhere it is displayed.

Three things about this that are not obvious:

- **`0000_baseline.sql` is guarded with `IF NOT EXISTS`, and later ones are
  not.** That guard is how a database written before migrations adopts them: it
  already has the tables and no `__drizzle_migrations` to say so, so `migrate()`
  runs 0000 once, changes nothing, and records the baseline. Regenerating 0000
  means re-applying those guards.
- **`0001_fts5.sql` is hand-written and always will be.** Drizzle cannot express
  `CREATE VIRTUAL TABLE ... USING fts5`, so drizzle-kit will neither generate
  those two tables nor drop them. It is the only DDL here not generated.
- **`applySchema` still exists and still takes a handle**, because fifteen test
  files build their in-memory database with it. It runs the migrations now.
  `adoptLegacyColumns` beside it is frozen — it carries the guarded `ALTER`s for
  databases created before migrations, and nothing new belongs in it.

A column the ORM declares but the database lacks is caught by
`db/schema-parity.test.ts`, which cannot catch generated drift but does catch a
hand-edited migration.

Building the pre-workspace shape (`user_id` on the scoped tables) is
`db/testing/legacy-database.ts`. It is what `backfill` and `dropLegacyUserId`
exist to move forward, and it is no longer part of the schema a fresh database
gets.

## The playbook

**Every run makes a second model call.** After `emit({type:"done"})`, `reflect`
in `services/playbook/reflector.ts` sends the transcript, the run's tool calls
and the existing playbook to the same model and asks what changed. It is
deliberately not awaited — a run's latency is unaffected and a reflector failure
cannot fail a run that already answered — which also means **it does not show up
in the run's own traces or timings**. Look for `playbook.reflected` in the log.

What comes back is a *delta*, never a document. There is no operation that
rewrites the playbook and none that deletes a bullet, because both are how an
evolving context dies: asked to rewrite, a model compresses hard-won detail to
nothing (measured upstream at 18k tokens of playbook rewritten down to 122, with
accuracy falling below the no-playbook baseline). Adding one would undo the
design. Removal is decided by counters, or by the user in the UI.

Three things that are easy to get wrong:

- **The merge is in `playbook.repository.ts`, in code, not in the prompt.** An
  `add` whose fingerprint already exists is not a duplicate and not a no-op — it
  becomes a `helpful` increment on the bullet it matched, which is where most of
  the ranking signal actually comes from.
- **The helpful/harmful signal is computed, not judged.** `playbook/signals.ts`
  reads the run's tool calls and hands the reflector conclusions. The one that
  matters is `searching`: three or more calls to *one* tool with *different*
  arguments. Every such call succeeds individually, so nothing else in the
  system can see it, and it is the exact shape of a run hunting for a tool that
  does not exist.
- **Everything the reflector returns is untrusted.** It is two steps downstream
  of MCP results, which are text from someone else's server. `parseDeltas` drops
  ops naming ids that do not exist, caps bullets at 320 chars and runs at 5 ops.

The prompt block is capped at 6k characters (`PLAYBOOK_CHAR_CAP`). Over it, the
lowest-scoring bullets fall out of the *prompt* and stay in the database —
`inPrompt` in the API response is what the panel greys out.

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

**Neither bound destroys data any more.** What is cut goes to
`<workspace>/.pixelspace/tool-output/` and the model is handed the path, because the
run that motivated this did not fail on size — it failed on *refusal*. An
exhausted `RUN_CHAR_BUDGET` returned "do not retry this call", the agent stopped
reading, and having no way to tell our cap from the remote server's, it told the
user Nextcloud was rate-limiting it. Nextcloud had never complained.

Three things follow, and all three are load-bearing:

- **The path is a bare host path on purpose.** `docker.ts` mounts the workspace
  at `<p>:<p>`, so the string written by the API is the string `read` and `bash`
  resolve inside the container. Break that identity and the pointer becomes a
  path to nowhere — the same failure mode as changing `SANDBOX_ROOT`.
- **Spilling is best-effort and silent on failure.** A workspace that cannot be
  written to degrades to plain truncation, which is exactly the old behaviour.
  It must never fail a tool call that already has its answer in hand.
- **`capResult` cuts the middle, not the tail.** A listing carries its schema at
  the top and its totals at the bottom; dropping the tail is what made "how many
  contacts are there" unanswerable from a result that had counted every one.
  Codex's `truncate_middle_chars` does the same thing for the same reason.

Spills are swept once per run, seven days' retention (`SPILL_RETENTION_MS`).

## Reading an image

`read_image` is a chat model borrowing a different model's eyes. The tool runs
in the API process, posts the bytes to `env.visionModel` on the same gateway,
and returns **prose**. Nothing about the run's own model changes — a run on
`ds4-flash` reads a screenshot fine, and `ds4-flash` cannot see images at all.

Returning the picture instead would fail three ways at once, which is why it
does not: `flattenContent` renders an image content block as the literal
`[image]`, the pi model is declared `input: ["text"]`, and one base64 PNG
measured 135,944 characters against a 40,000 `RESULT_CHAR_CAP`.

Which gateway models can actually see, measured by handing each the same PNG:

| model | image input |
| --- | --- |
| `qwen3.8-27b`, `gemini-3.1-flash-image` | yes |
| `ds4-flash`, `nemotron-3.5-lightning` | `... is not a multimodal model` (HTTP 400) |

Two things that are load-bearing:

- **`resolveInWorkspace` is a security boundary, not tidiness.** `bash` and
  `read` are confined to the sandbox container; this tool is not. It runs with
  the API's privileges, and `SANDBOX_ROOT` is bind-mounted into the API
  container at an identical path — so an unchecked `../..` would read
  `apps/api/.env` and post it to a model. The prefix check also rejects
  `ws1-backup` for `ws1`, which a bare `startsWith` accepts.
- **No `max_tokens` on the vision call.** Same trap `image.service` documents
  for generation: reasoning comes out of the same budget, so a small cap
  returns `finish_reason: "length"` with empty content and no error.

An arbitrary `http(s)` source is deliberately unsupported — fetching a
caller-supplied URL from the API process would let any prompt reach anything on
the compose network.

**Image ids are `crypto.randomUUID()`.** `generatedImageId` once required an
`img_` prefix, so it matched no real image at all: every `/api/images/<id>` URL
fell through to the file branch and failed as "outside your workspace". Its
tests passed because they asserted the invented format. If you touch that
function, check what `image.repository` actually mints.

## Pasting an image into the chat

An image pasted into the composer is uploaded before the message is sent
(`POST /api/images`), so the thumbnail appears while the user is still typing
and the chat request carries an id rather than a megabyte of base64. It lands in
the same bucket and table as a generated one — `source` distinguishes them,
because otherwise an upload is a generation whose model happened to be blank,
and that is how a cost report goes wrong.

**The model learns about it from the message text, not a field.** The chat
controller appends a note naming the `/api/images/<id>` URLs and telling it to
call `read_image`. Text, because that needs no change to `pi.service`, survives
into the stored transcript so turn five still knows what turn one was shown, and
gives the console the URLs to draw thumbnails from. `transcript.tsx` hides the
note and renders the pictures — the regex there and the wording in
`describeAttachments` are one contract, so changing the sentence changes the UI.

SVG is not uploadable. It is a document that can carry script, and these bytes
are served back from the console's own origin.

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

## Reading a transcript

Reasoning rows remain stored but are not drawn in `transcript.tsx`. Tool rows
are also stored regardless of display state. The user preference
`showToolTrace` is off by default; when enabled, consecutive tool calls in one
agent-loop batch share a collapsed activity row in transcript order. Expanding
it reveals each tool's exact arguments, result, duration, and failure state.
`render_ui` is always visible because its arguments are the component the user
asked the agent to draw. Keep transcript filtering in `lib/transcript.ts` pure
so hidden and visible modes can be tested without rendering React.

**A stored `thinking` row is text, or JSON.** It was bare text, and rows written
then still are; a timed one is `{text, ms}`, which is where `Thought for 6
seconds` comes from on a reloaded conversation. `parseThinking` in
`lib/transcript.ts` treats anything that is not exactly that shape as the
thought itself — a thought that opens with `{` is a thought, not a record.
Nothing marks where reasoning *ends*, so the duration is restamped on every
delta rather than closed on an event that does not exist.

## Web routing

TanStack Router, file-based, routes in `apps/web/src/routes/`. `routeTree.gen.ts`
is generated by the Vite plugin but **committed on purpose**: `build` runs
`tsc -b` before Vite, so a fresh clone without it fails typecheck before the
plugin ever runs.

Providers that must outlive navigation (`PreferencesProvider`,
`TooltipProvider`, `WorkspaceContext`, `AgentBoardContext`) belong in
`__root.tsx`, not in a route.

`PreferencesProvider` owns browser-local display choices. It validates the
stored `pixelspace-preferences` value, updates the document language, and
exposes the typed dictionary in `shared/lib/i18n.ts`. Language changes are
immediate and intentionally do not require a server round trip; these are
display preferences, not workspace data.

**`AgentBoardContext` is in that list for a reason that will bite if it moves.**
A run is an open SSE stream held in `useAgentBoard`'s refs. Mounted inside the
chat route, opening any other page unmounted the only thing listening to it:
the stream kept arriving and the answer landed in a component nobody would see
again. `apps/web/src/routes/index.tsx` renders the chat page, but it does not
own the runs.

Every page is wrapped in `AppShell` (`features/navigation`), which draws the
sidebar and owns the settings modal. There is **one 260px labelled sidebar**,
and it holds both kinds of navigation: icon-and-word destinations at the top,
the runs underneath, and account controls at the bottom. Collapsing removes the
whole column and leaves a restore button in the page header; do not bring back
the permanent icon rail or a second chat-only column. On narrow screens the
same labelled sidebar is presented as a sheet.

A page in that list is a route file plus a thin component around one of the
panels in `features/resources`; those panels were tabs in a drawer, so each
still carries its own counts row but no longer its own heading, which the page
header now supplies.

Because the run list is on every page, choosing a run also navigates — see
`openAgent` in `sidebar.tsx`. Without that, opening a run from Docs would
change what an invisible page was showing and look like nothing happened.

## Deploying

Three targets, and they are not the same machine.

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

**On-prem hosts and DGX Spark.** `scripts/pixelspace` is the first-party
single-host operator; `ON_PREM.md` is its user contract. It supports Linux
`amd64` and `arm64`, defaults to loopback plus `AUTH_MODE=local`, and bootstraps
the first administrator from a TTY or protected password file. LAN exposure
requires either local auth behind TLS or `AUTH_MODE=proxy` behind a trusted TLS
proxy and firewall. Persistent data and workspaces live outside the checkout. Build mode
builds API, web, and sandbox images locally; image mode accepts only immutable
multi-architecture digest references and reuses images already loaded for an
offline install. Pixelspace never installs, restarts, or reconfigures the host's
model service; `CUSTOM_BASE_URL` points at a separately managed
OpenAI-compatible gateway. Lifecycle operations are locked: backup captures
SQLite, quiesced workspace sandboxes, RustFS, MCP cache, and decryption secrets;
restore uses safe archive extraction, creates a safety backup, and attempts
automatic rollback after a failed cutover; upgrade re-runs doctor and backs up
before refresh; uninstall preserves data unless both `--purge --yes` are present.
Packaged installs additionally support `configure-update`, `check-update`, and
`update` against a provider-neutral private HTTPS manifest. The client keeps
authorization headers and signed bundle URLs out of argv/logs, verifies the
architecture-specific SHA-256 before safe extraction, creates a full backup,
and restores the prior runtime plus data if activation or health checks fail.
Registry image mode still requires digests; checksum-verified offline image
tars are the immutable input for package installs. Release CI attaches each
bundle's `.sha256` sidecar. The storage/channel contract and the one-time
bootstrap for older customer bundles are documented in `ON_PREM.md`.

**CI pins bun, and the pin is in the workflow, not in a manifest.** `BUN_VERSION`
in `deploy.yml` decides what CI runs; nothing checks it against what you have.
Upgrading bun locally without bumping it means the suite you watched pass is not
the suite that gates the deploy. The binary comes from npm's platform package
rather than `bun.sh/install`, because that script pulls ~35MB from github.com and
a deploy has already died on `curl: (56)` doing it.

## Legacy name compatibility

Fresh deployments use Pixelspace for the Compose project, volumes, container
names, and media bucket. The installer migrates legacy Compose volumes before
starting the renamed stack, keeps the source volumes until the new stack passes
health checks, then removes the old resources.

Two internal compatibility values can still contain the former name:

- **`SALT` in `lib/crypto.ts`** derives the key every stored secret was
  encrypted with. A new salt derives a different key, and every MCP header,
  database URL and connector token in `app.db` becomes undecryptable.
- Existing `.env` files can keep **`S3_BUCKET=salur-media`** so stored images
  remain readable. New installs default to `pixelspace-media`; changing an
  existing bucket value without copying its objects breaks old image links.

`.forgejo/workflows/deploy.yml` also still deploys to `salur@/opt/salur`: that
is a user and a directory on the deploy host, not a string in this repo.

Everything else — package names, the sandbox container prefix, the sandbox
image tag, `SANDBOX_ROOT`, and the spill directory — is Pixelspace. The on-prem
installer also removes the unused legacy sandbox image tag after a successful
resource migration.

## Conventions

Comments explain **why**, not what, and are written where the reasoning is
non-obvious — a cap that exists because of a specific failure says which one.
Repository modules own their tables exclusively. Secrets are selected by explicit
column list so a new field cannot leak by being added. Tests run against a real
in-memory SQLite built from `applySchema`, never a mock.
