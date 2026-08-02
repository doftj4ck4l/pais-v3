# Sandboxed agent workspace — spike design

- **Date:** 2026-08-03
- **Status:** Approved, not yet implemented
- **Type:** Feasibility spike (not a product increment)

## Why this exists

The long-term idea is a web-based agent harness for people who can't use a
terminal: connect a folder, ask an agent to work on it, get the result back —
without installing anything.

Almost every part of that is engineering we already know how to do (auth,
billing, quotas, channels). Exactly one part is genuinely unproven:

> **Can the pi agent do real work in an isolated container, against a workspace
> that outlives the container, driven from the browser?**

This spike answers that and nothing else. If the answer is no, the product needs
rethinking and we found out in days rather than months.

### The tradeoff we are knowingly accepting

Coding agents normally run on the user's own machine because the user's files,
credentials and toolchain are already there. Hosting means "upload your stuff to
my server", which is a real onboarding and trust cost that Claude Code does not
have. We are accepting that cost deliberately, because the target user cannot use
a terminal at all. It is the main thing to watch in early user reactions — not a
reason to change course mid-spike.

## What exists today

`apps/api` runs the real pi runtime (`@earendil-works/pi-agent-core@0.83.0`) with
a layered structure (routes → controllers → services → repositories). Runs stream
over SSE and are persisted to SQLite. `apps/web` is a multi-agent console.

Today the agent's shell and file tools operate directly on the API server's own
filesystem, in `apps/api/workspace`:

```ts
// services/pi.service.ts
const workspaceDir = workspace ?? path.resolve(process.cwd(), "workspace");
const env = new NodeExecutionEnv({ cwd: workspaceDir });
const builtinTools = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()];

const harness = new AgentHarness({
  /* ... */
  toolContext: { env },
  tools: [...builtinTools, ...agentTools],
});
```

That is fine for one trusted developer and unacceptable for anyone else: the
model gets `bash` on the host running the API.

## The seam

pi already defines the abstraction this spike needs. Every built-in tool is
constructed against an execution context, not against Node:

```ts
interface ExecutionEnv extends FileSystem, Shell {}
interface ExecutionToolContext { env: ExecutionEnv }
```

`ExecutionEnv` has **18 distinct members**: `exec` from `Shell`, plus a
17-member `FileSystem` surface — `cwd`, `absolutePath`, `canonicalPath`,
`joinPath`, `exists`, `fileInfo`, `listDir`, `createDir`, `createTempDir`,
`createTempFile`, `readTextFile`, `readTextLines`, `readBinaryFile`,
`writeFile`, `appendFile`, `remove`, `cleanup`. (`cleanup` is declared on both
interfaces.) That is the full size of the implementation job.

So swapping the agent's entire world for a container is **one new class plus a
one-line change** to `toolContext: { env }`. `bash`, `read`, `write`, `edit` and
the existing skills all follow automatically, with no changes to any tool.

This seam is the single most important finding behind this design. It is why the
backend choice below is cheap and reversible.

## Design

### Topology

```
web → POST /api/chat → chat.controller → pi.service
                                            └─ ExecutionEnv
                                                 ├─ NodeExecutionEnv    (existing, dev only)
                                                 └─ DockerExecutionEnv  (new)
                                                      ├─ Shell.exec  → docker exec
                                                      └─ FileSystem  → bind-mounted workspace
```

A **container is disposable; a workspace is not.** Each user gets a host
directory bind-mounted into their container at `/workspace`. A container is
started on demand, reused by later runs while it is still warm, and destroyed
once idle. The directory outlives all of them.

This is the "persistent volume + on-demand compute" model, which is the honest
version of "every user gets their own machine".

### Components

| File | Responsibility |
| --- | --- |
| `services/sandbox/docker-execution-env.ts` | Implements pi's `ExecutionEnv`. `Shell.exec` runs via `docker exec`; `FileSystem` operates on the bind-mounted host directory. |
| `services/sandbox/sandbox.service.ts` | `acquire(userId)` / `release(userId)`. Ensures the workspace directory, starts or reuses a container, stops it when idle. |
| `services/sandbox/docker.ts` | Thin Docker **CLI** wrapper (`child_process.spawn`): run, exec, stop, remove, isRunning, ensureImage. |
| `repositories/sandbox.repository.ts` | Persist the user ↔ container ↔ workspace mapping. |
| `models/schema.ts` | New `sandboxes` table. |
| `config/env.ts` | `SANDBOX_BACKEND`, `SANDBOX_IMAGE`, `SANDBOX_ROOT`, `SANDBOX_IDLE_MS`. |
| `services/pi.service.ts` | Choose the env by backend; otherwise untouched. |

### Why bind mount rather than a named volume or S3

**Bind mount** (chosen): file operations are plain Node `fs` against the host
directory; only shell commands cross into Docker. Far less code across 17
filesystem methods, and the workspace is visible in Finder — which is the entire
file-in/file-out loop for a spike, with no upload UI to build.

The workspace is mounted at the **identical absolute path** inside the container
(`/Users/<you>/mixmatch-workspaces/<user>` → the same path in the container), so
host and container share one path namespace and no translation is ever needed.
This is what allows `DockerExecutionEnv` to delegate all 17 `FileSystem` methods
to the existing `NodeExecutionEnv` and override only `exec`.

**Named volume + tar I/O** (rejected for now): properly isolated and closer to
how a hosted backend will behave, but every filesystem method becomes a
`putArchive`/`getArchive` round trip, and you cannot inspect the files without
exec-ing in.

**S3** (rejected as the workspace): not a filesystem — no atomic rename, no
append, no real directories — and `bash` cannot target a bucket, so `npm
install` and `git clone` are impossible. Mounting it (s3fs/mountpoint-s3) is
slowest at exactly what agents do most: many small files, rename, append.

S3 remains the right answer *underneath* the workspace later — sync down on
acquire, sync up on release — which buys host portability once containers can
land on any machine. That is precisely why `acquire()` / `release()` exist as a
seam now.

> **Concurrency note.** Sync-down/sync-up has a data-loss bug for this product
> specifically: the console spawns parallel agents, so two agents for one user
> would both pull, both push, and last-write-wins would silently clobber one. A
> shared bind mount has no such problem — concurrent agents share one filesystem,
> like two terminals on one machine. Any future S3 layer must handle this.

### Lifecycle

1. Run starts. `sandbox.service.acquire(userId)` returns a ready container.
   - Workspace directory created if absent (`SANDBOX_ROOT/<userId>`).
   - Existing running container reused; otherwise a new one is started from
     `SANDBOX_IMAGE` with the workspace bind-mounted at `/workspace`.
2. The agent runs. All `bash`/`read`/`write`/`edit` calls resolve inside the
   container or against the mounted directory.
3. Run ends. `release(userId)` marks the sandbox idle. A container idle beyond
   `SANDBOX_IDLE_MS` is stopped and removed. **The workspace directory is never
   deleted.**

Because containers are reused while warm, back-to-back runs skip cold start.

### Data model

```ts
sandboxes {
  userId        text primary key
  containerId   text | null      // null once stopped
  workspacePath text
  image         text
  createdAt     integer
  lastUsedAt    integer
}
```

`containerId` being null is normal and means "workspace exists, container is
cold" — not an error state.

### Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_BACKEND` | `node` | `node` (today's behaviour) or `docker` |
| `SANDBOX_IMAGE` | `node:22-bookworm-slim` | Image the agent works inside |
| `SANDBOX_ROOT` | `~/mixmatch-workspaces` | Where user workspaces live on the host |
| `SANDBOX_IDLE_MS` | `300000` | Stop a container after this much idle time |

Defaulting to `node` means this change is inert until explicitly switched on.

### Error handling

- **Docker daemon unreachable** → the run fails with a clear, fixable message
  ("Docker isn't running — start Docker Desktop"). **No silent fallback to the
  host filesystem**, which would quietly defeat the entire purpose of the spike.
- **Container fails to start** → same path; surfaced as an `error` frame.
- **`exec` non-zero exit** → not an error. Returned to the agent as stdout /
  stderr / exit code, exactly as pi's `Shell` contract requires, so the agent can
  read the failure and react.
- **`exec` timeout** → honours `ShellExecOptions.timeout`; the command is killed
  and reported.
- **Path escape** → every path is resolved and asserted to be inside the user's
  workspace before use. Reject rather than clamp.

Sandbox failures ride the existing run-status path, so a failed run is stored as
`error` and shows correctly in the sidebar.

## Verified before planning

These were probed against the real daemon (Docker Desktop 28.0.1) so the plan
rests on measurements, not assumptions:

| Check | Result |
| --- | --- |
| Container reads host-written files, and vice versa | works |
| Nested directories created in-container visible on host | works |
| `pwd` inside container | identical to the host path — one namespace |
| Ownership of container-written files on host | `farhan:staff`, host can rewrite |
| Workspace survives `docker rm -f` | survives |
| `dockerode` exec under Bun | **broken** — HTTP 101 upgrade mishandled by `docker-modem` |
| `docker exec` via `child_process.spawn` | clean separate stdout/stderr, true exit code |

The `dockerode` finding is why the implementation uses the **Docker CLI via
`spawn`** rather than an SDK. Since exec must go through the CLI regardless,
container lifecycle uses it too — one mechanism instead of two, and no
Bun-compatibility surface.

## Testing

**Step 1 — standalone script, before any app wiring.** This is the actual
experiment and must run first:

```
create container + workspace → write a file → destroy container
→ new container → read the file          → assert present
→ modify it → destroy container
→ new container → read it again          → assert modification present
```

The second cycle matters. E2B's [issue #884](https://github.com/e2b-dev/E2B/issues/884)
was exactly this failure — files surviving the first resume and vanishing on the
second — so the test deliberately repeats. If step 1 fails, stop; the design is
wrong and nothing downstream is worth building.

**Step 2 — `DockerExecutionEnv` unit tests** against a live daemon: each
filesystem method, plus `exec` covering success, non-zero exit, timeout, and
path-escape rejection.

**Step 3 — end to end through the UI**: ask an agent to create a file, wait for
the container to be reaped, ask a *new* agent to read and edit it.

## Success criteria

The spike succeeds when, with `SANDBOX_BACKEND=docker`:

1. An agent creates a file via `bash` and via `write`.
2. Its container is destroyed.
3. A **new** agent, in a **new** run, reads and edits that same file.
4. Steps 2–3 repeat successfully a second time.
5. All of it driven from the browser, with no terminal involved.
6. The API server's own filesystem is untouched throughout.

## Explicitly not in scope

Auth, user accounts, billing, quotas, abuse handling, WhatsApp or any channel,
preset agents, telemetry, E2B, S3, and multi-host scheduling. Each is real work;
none of it matters if the criteria above cannot be met.

## Risks and open questions

| Risk | Notes |
| --- | --- |
| Docker becomes a hard dev dependency | Mitigated by `SANDBOX_BACKEND=node` remaining the default |
| File ownership mismatch | **Measured, not a problem on Docker Desktop for Mac:** files written by root in the container land as `farhan:staff` on the host, and the host can rewrite them. Docker Desktop's filesystem layer maps ownership to the host user. This *would* bite on native Linux, where a `--user` mapping becomes necessary. |
| Cold start latency | First message after idle pays container start. Needs a visible "starting" state in the UI or it reads as broken |
| Image contents | `node:22-bookworm-slim` has no `git`, `python`, or build tools. What the agent can actually do is bounded by the image — likely needs a custom one |
| Disk growth | Workspaces are never deleted. Fine for a spike, needs a policy before real users |

## What comes after, if it works

In rough order: a visible sandbox state in the UI, file upload/download so the
loop works without Finder, a purpose-built image, then auth and multi-tenancy,
then swapping `DockerExecutionEnv` for a hosted backend (E2B) behind the same
interface.

None of that is committed here. The next decision comes after step 1 either
passes or fails.
