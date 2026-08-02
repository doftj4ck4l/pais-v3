# Sandboxed Agent Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pi agent's shell and file tools run inside a per-user Docker container against a workspace that outlives the container, switchable by env var and driven from the browser.

**Architecture:** pi already abstracts the agent's world behind `ExecutionEnv` (`FileSystem` + `Shell`), supplied to `AgentHarness` as `toolContext: { env }`. We add a `DockerExecutionEnv` that delegates every filesystem method to the existing `NodeExecutionEnv` and overrides only `exec` to run via `docker exec`. This works because the workspace is bind-mounted at the **identical absolute path** inside the container, so host and container share one path namespace. A `sandbox.service` owns container lifecycle (acquire / release / reap idle); workspaces are never deleted.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle + SQLite, `@earendil-works/pi-agent-core@0.83.0`, Docker CLI via `node:child_process`.

## Global Constraints

- **Docker CLI, not an SDK.** `dockerode`'s exec is broken under Bun (HTTP 101 upgrade mishandled by `docker-modem`). Use `child_process.spawn("docker", [...])` with **array args, never a shell string**.
- **Default is `node`.** `SANDBOX_BACKEND` defaults to `node`; every change here is inert until explicitly switched to `docker`.
- **No silent fallback.** If Docker is unavailable when `SANDBOX_BACKEND=docker`, fail loudly with a fixable message. Never quietly fall back to the host filesystem.
- **Workspaces are never deleted.** Only containers are stopped and removed.
- **Non-zero exit is not an error.** `exec` returns `ok({stdout, stderr, exitCode})` for a failed command; only abort/timeout/spawn failure return `err(...)`.
- **Identical-path mount.** Bind `<hostPath>:<hostPath>` and set `-w <hostPath>`. Never mount at `/workspace`.
- Existing layered structure holds: `routes → controllers → services → repositories`, `models/` for Drizzle schema.
- Verify with `cd apps/api && bunx tsc --noEmit` and `bun test`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/api/scripts/sandbox-persistence-check.ts` | Standalone proof: file survives two container destroy/recreate cycles |
| `apps/api/src/services/sandbox/docker.ts` | Docker CLI wrapper: `dockerAvailable`, `ensureImage`, `runDetached`, `execInContainer`, `isRunning`, `removeContainer` |
| `apps/api/src/services/sandbox/docker-execution-env.ts` | `DockerExecutionEnv implements ExecutionEnv` |
| `apps/api/src/repositories/sandbox.repository.ts` | Persist user ↔ container ↔ workspace |
| `apps/api/src/services/sandbox/sandbox.service.ts` | `acquire` / `release` / `reapIdle` |
| `apps/api/src/models/schema.ts` | `sandboxes` table (modify) |
| `apps/api/src/config/env.ts` | Sandbox settings (modify) |
| `apps/api/src/services/pi.service.ts` | Choose env by backend (modify) |
| `apps/api/src/db/client.ts` | `ensureSchema` gains the sandboxes table (modify) |

---

## Task 1: Prove the persistence mechanic

Nothing downstream matters if this fails. No app code — a standalone script.

**Files:**
- Create: `apps/api/scripts/sandbox-persistence-check.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks. It is a gate.

- [ ] **Step 1: Write the script**

```ts
// apps/api/scripts/sandbox-persistence-check.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE = "node:22-bookworm-slim";
const WS = path.join(os.homedir(), "mixmatch-workspaces", "persistence-check");

function sh(args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn("docker", args);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ out: out.trim(), code: code ?? -1 }));
  });
}

async function startContainer(): Promise<string> {
  const r = await sh(["run", "-d", "-v", `${WS}:${WS}`, "-w", WS, IMAGE, "sleep", "infinity"]);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.out}`);
  return r.out;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

console.log("cycle 1: create file in container");
let id = await startContainer();
await sh(["exec", id, "sh", "-lc", `echo one > ${WS}/note.txt`]);
await sh(["rm", "-f", id]);
assert(fs.readFileSync(path.join(WS, "note.txt"), "utf8").trim() === "one", "file survived container removal");

console.log("cycle 2: new container reads and modifies it");
id = await startContainer();
const read1 = await sh(["exec", id, "cat", `${WS}/note.txt`]);
assert(read1.out === "one", "new container reads the old file");
await sh(["exec", id, "sh", "-lc", `echo two >> ${WS}/note.txt`]);
await sh(["rm", "-f", id]);

console.log("cycle 3: the one that broke E2B — second resume");
id = await startContainer();
const read2 = await sh(["exec", id, "cat", `${WS}/note.txt`]);
assert(read2.out === "one\ntwo", "modification survived the SECOND cycle");
await sh(["rm", "-f", id]);

console.log("\nPERSISTENCE PROVEN");
```

- [ ] **Step 2: Run it**

Run: `cd apps/api && bun scripts/sandbox-persistence-check.ts`
Expected: three `ok:` lines then `PERSISTENCE PROVEN`, exit 0.

**If this fails, stop and report. Do not continue to Task 2.**

- [ ] **Step 3: Commit**

```bash
git add apps/api/scripts/sandbox-persistence-check.ts
git commit -m "test: prove docker workspace survives container destruction"
```

---

## Task 2: Docker CLI wrapper

**Files:**
- Create: `apps/api/src/services/sandbox/docker.ts`
- Test: `apps/api/src/services/sandbox/docker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DockerExec = { stdout: string; stderr: string; exitCode: number }`
  - `type ExecOptions = { cwd?: string; env?: Record<string,string>; timeoutMs?: number; signal?: AbortSignal; onStdout?: (c: string) => void; onStderr?: (c: string) => void }`
  - `type ExecOutcome = { kind: "ok"; result: DockerExec } | { kind: "timeout" } | { kind: "aborted" } | { kind: "spawn_error"; message: string }`
  - `dockerAvailable(): Promise<boolean>`
  - `ensureImage(image: string): Promise<void>`
  - `runDetached(o: { image: string; workspacePath: string; name: string }): Promise<string>`
  - `isRunning(containerId: string): Promise<boolean>`
  - `removeContainer(containerId: string): Promise<void>`
  - `execInContainer(containerId: string, command: string, options?: ExecOptions): Promise<ExecOutcome>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/sandbox/docker.test.ts
import { expect, test, beforeAll, afterAll } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  dockerAvailable, ensureImage, runDetached, isRunning, removeContainer, execInContainer,
} from "./docker";

const IMAGE = "node:22-bookworm-slim";
const WS = path.join(os.homedir(), "mixmatch-workspaces", "test-docker");
let id = "";

beforeAll(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  await ensureImage(IMAGE);
  id = await runDetached({ image: IMAGE, workspacePath: WS, name: `mm-test-${Date.now()}` });
});

afterAll(async () => {
  if (id) await removeContainer(id);
  fs.rmSync(WS, { recursive: true, force: true });
});

test("daemon is available", async () => {
  expect(await dockerAvailable()).toBe(true);
});

test("container is running", async () => {
  expect(await isRunning(id)).toBe(true);
});

test("exec captures stdout, stderr and exit code separately", async () => {
  const r = await execInContainer(id, "echo out; echo err >&2; exit 3");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.result.stdout.trim()).toBe("out");
  expect(r.result.stderr.trim()).toBe("err");
  expect(r.result.exitCode).toBe(3);
});

test("exec runs in the workspace by default", async () => {
  const r = await execInContainer(id, "pwd");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.result.stdout.trim()).toBe(WS);
});

test("exec honours a timeout", async () => {
  const r = await execInContainer(id, "sleep 5", { timeoutMs: 300 });
  expect(r.kind).toBe("timeout");
});

test("exec honours an abort signal", async () => {
  const ac = new AbortController();
  const p = execInContainer(id, "sleep 5", { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  expect((await p).kind).toBe("aborted");
});

test("exec streams stdout chunks", async () => {
  const chunks: string[] = [];
  await execInContainer(id, "echo streamed", { onStdout: (c) => chunks.push(c) });
  expect(chunks.join("")).toContain("streamed");
});

test("isRunning is false for an unknown container", async () => {
  expect(await isRunning("does-not-exist-xyz")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/services/sandbox/docker.test.ts`
Expected: FAIL — cannot resolve `./docker`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/sandbox/docker.ts
import { spawn } from "node:child_process";

export type DockerExec = { stdout: string; stderr: string; exitCode: number };

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ExecOutcome =
  | { kind: "ok"; result: DockerExec }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "spawn_error"; message: string };

/** Run the docker CLI with array args — never a shell string. */
function docker(args: string[], options: ExecOptions = {}): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("docker", args);
    } catch (e) {
      resolve({ kind: "spawn_error", message: (e as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const kill = () => child.kill("SIGKILL");
    const onAbort = () => { kill(); finish({ kind: "aborted" }); };
    const timer = options.timeoutMs
      ? setTimeout(() => { kill(); finish({ kind: "timeout" }); }, options.timeoutMs)
      : undefined;

    if (options.signal?.aborted) { kill(); finish({ kind: "aborted" }); return; }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d) => { const s = String(d); stdout += s; options.onStdout?.(s); });
    child.stderr?.on("data", (d) => { const s = String(d); stderr += s; options.onStderr?.(s); });
    child.on("error", (e) => finish({ kind: "spawn_error", message: e.message }));
    child.on("close", (code) => finish({ kind: "ok", result: { stdout, stderr, exitCode: code ?? -1 } }));
  });
}

async function plain(args: string[]): Promise<DockerExec> {
  const outcome = await docker(args);
  if (outcome.kind !== "ok") throw new Error(`docker ${args[0]} failed: ${outcome.kind}`);
  return outcome.result;
}

export async function dockerAvailable(): Promise<boolean> {
  const outcome = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5000 });
  return outcome.kind === "ok" && outcome.result.exitCode === 0;
}

export async function ensureImage(image: string): Promise<void> {
  const found = await plain(["images", "-q", image]);
  if (found.stdout.trim()) return;
  const pulled = await docker(["pull", image], { timeoutMs: 600_000 });
  if (pulled.kind !== "ok" || pulled.result.exitCode !== 0) {
    throw new Error(`Could not pull image ${image}`);
  }
}

/**
 * Start a detached container with the workspace bind-mounted at the SAME
 * absolute path it has on the host, so both sides share one path namespace.
 */
export async function runDetached(o: {
  image: string;
  workspacePath: string;
  name: string;
}): Promise<string> {
  const r = await plain([
    "run", "-d",
    "--name", o.name,
    "-v", `${o.workspacePath}:${o.workspacePath}`,
    "-w", o.workspacePath,
    o.image,
    "sleep", "infinity",
  ]);
  if (r.exitCode !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export async function isRunning(containerId: string): Promise<boolean> {
  const r = await plain(["inspect", "-f", "{{.State.Running}}", containerId]);
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

export async function removeContainer(containerId: string): Promise<void> {
  await docker(["rm", "-f", containerId], { timeoutMs: 30_000 });
}

export function execInContainer(
  containerId: string,
  command: string,
  options: ExecOptions = {},
): Promise<ExecOutcome> {
  const args = ["exec"];
  if (options.cwd) args.push("-w", options.cwd);
  for (const [k, v] of Object.entries(options.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(containerId, "sh", "-lc", command);
  return docker(args, options);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/services/sandbox/docker.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sandbox/docker.ts apps/api/src/services/sandbox/docker.test.ts
git commit -m "feat: docker CLI wrapper for sandbox containers"
```

---

## Task 3: DockerExecutionEnv

**Files:**
- Create: `apps/api/src/services/sandbox/docker-execution-env.ts`
- Test: `apps/api/src/services/sandbox/docker-execution-env.test.ts`

**Interfaces:**
- Consumes: `execInContainer`, `runDetached`, `removeContainer`, `ensureImage` from Task 2.
- Produces: `class DockerExecutionEnv implements ExecutionEnv`, constructed as
  `new DockerExecutionEnv({ containerId: string, cwd: string })`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/sandbox/docker-execution-env.test.ts
import { expect, test, beforeAll, afterAll } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ensureImage, runDetached, removeContainer } from "./docker";
import { DockerExecutionEnv } from "./docker-execution-env";

const IMAGE = "node:22-bookworm-slim";
const WS = path.join(os.homedir(), "mixmatch-workspaces", "test-env");
let id = "";
let env: DockerExecutionEnv;

beforeAll(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  await ensureImage(IMAGE);
  id = await runDetached({ image: IMAGE, workspacePath: WS, name: `mm-env-${Date.now()}` });
  env = new DockerExecutionEnv({ containerId: id, cwd: WS });
});

afterAll(async () => {
  await env.cleanup();
  if (id) await removeContainer(id);
  fs.rmSync(WS, { recursive: true, force: true });
});

test("exec runs inside the container", async () => {
  const r = await env.exec("echo hello");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.stdout.trim()).toBe("hello");
  expect(r.value.exitCode).toBe(0);
});

test("a failed command is ok:true with a non-zero exit code", async () => {
  const r = await env.exec("exit 7");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.exitCode).toBe(7);
});

test("timeout returns err with code 'timeout'", async () => {
  const r = await env.exec("sleep 5", { timeout: 0.3 });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("timeout");
});

test("abort returns err with code 'aborted'", async () => {
  const ac = new AbortController();
  const p = env.exec("sleep 5", { abortSignal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const r = await p;
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("aborted");
});

test("filesystem writes are visible to the container", async () => {
  const w = await env.writeFile(path.join(WS, "from-env.txt"), "written");
  expect(w.ok).toBe(true);
  const r = await env.exec("cat from-env.txt");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.stdout.trim()).toBe("written");
});

test("container writes are visible to the filesystem methods", async () => {
  await env.exec("echo from-container > made-in-container.txt");
  const r = await env.readTextFile(path.join(WS, "made-in-container.txt"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.trim()).toBe("from-container");
});

test("cwd is the workspace path", () => {
  expect(env.cwd).toBe(WS);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/services/sandbox/docker-execution-env.test.ts`
Expected: FAIL — cannot resolve `./docker-execution-env`.

- [ ] **Step 3: Implement**

Filesystem methods delegate to `NodeExecutionEnv`, which is correct only because
the workspace is mounted at its own host path. Do not change the mount without
revisiting this.

```ts
// apps/api/src/services/sandbox/docker-execution-env.ts
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ExecutionError, err, ok } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import { execInContainer } from "./docker";

/**
 * The agent's world, inside a container.
 *
 * `exec` runs in the container. Every filesystem method delegates to a
 * NodeExecutionEnv over the bind-mounted host directory — valid because the
 * workspace is mounted at the identical absolute path on both sides, so a path
 * means the same thing to the agent whichever side answers.
 */
export class DockerExecutionEnv implements ExecutionEnv {
  private readonly host: NodeExecutionEnv;
  private readonly containerId: string;

  constructor(options: { containerId: string; cwd: string }) {
    this.containerId = options.containerId;
    this.host = new NodeExecutionEnv({ cwd: options.cwd });
  }

  get cwd(): string {
    return this.host.cwd;
  }

  async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const outcome = await execInContainer(this.containerId, command, {
      cwd: options.cwd ?? this.host.cwd,
      env: options.env,
      timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
      signal: options.abortSignal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });

    switch (outcome.kind) {
      case "ok":
        // A non-zero exit is information for the agent, not a failure to run.
        return ok(outcome.result);
      case "timeout":
        return err(new ExecutionError("timeout", `Command timed out: ${command}`));
      case "aborted":
        return err(new ExecutionError("aborted", `Command aborted: ${command}`));
      case "spawn_error":
        return err(new ExecutionError("spawn_error", outcome.message));
    }
  }

  // ---- FileSystem: delegated to the host view of the same directory ----
  absolutePath: ExecutionEnv["absolutePath"] = (...a) => this.host.absolutePath(...a);
  canonicalPath: ExecutionEnv["canonicalPath"] = (...a) => this.host.canonicalPath(...a);
  joinPath: ExecutionEnv["joinPath"] = (...a) => this.host.joinPath(...a);
  exists: ExecutionEnv["exists"] = (...a) => this.host.exists(...a);
  fileInfo: ExecutionEnv["fileInfo"] = (...a) => this.host.fileInfo(...a);
  listDir: ExecutionEnv["listDir"] = (...a) => this.host.listDir(...a);
  createDir: ExecutionEnv["createDir"] = (...a) => this.host.createDir(...a);
  createTempDir: ExecutionEnv["createTempDir"] = (...a) => this.host.createTempDir(...a);
  createTempFile: ExecutionEnv["createTempFile"] = (...a) => this.host.createTempFile(...a);
  readTextFile: ExecutionEnv["readTextFile"] = (...a) => this.host.readTextFile(...a);
  readTextLines: ExecutionEnv["readTextLines"] = (...a) => this.host.readTextLines(...a);
  readBinaryFile: ExecutionEnv["readBinaryFile"] = (...a) => this.host.readBinaryFile(...a);
  writeFile: ExecutionEnv["writeFile"] = (...a) => this.host.writeFile(...a);
  appendFile: ExecutionEnv["appendFile"] = (...a) => this.host.appendFile(...a);
  remove: ExecutionEnv["remove"] = (...a) => this.host.remove(...a);

  async cleanup(): Promise<void> {
    await this.host.cleanup();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/services/sandbox/docker-execution-env.test.ts && bunx tsc --noEmit`
Expected: 7 pass, typecheck clean.

If `ok` / `err` are not exported from the package root, import them from
`@earendil-works/pi-agent-core` per its `types.ts` exports — they are declared
alongside `Result`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sandbox/docker-execution-env.ts apps/api/src/services/sandbox/docker-execution-env.test.ts
git commit -m "feat: DockerExecutionEnv running pi tools inside a container"
```

---

## Task 4: Sandbox persistence

**Files:**
- Modify: `apps/api/src/models/schema.ts`
- Modify: `apps/api/src/db/client.ts`
- Create: `apps/api/src/repositories/sandbox.repository.ts`
- Test: `apps/api/src/repositories/sandbox.repository.test.ts`

**Interfaces:**
- Consumes: `db` from `../db/client`.
- Produces: `sandboxRepository` with
  `get(userId): Promise<SandboxRow | undefined>`,
  `upsert(row: { userId, containerId, workspacePath, image }): Promise<void>`,
  `clearContainer(userId): Promise<void>`,
  `touch(userId): Promise<void>`,
  `listIdle(olderThanMs: number): Promise<SandboxRow[]>`.

- [ ] **Step 1: Add the table to the schema**

```ts
// apps/api/src/models/schema.ts — append
/** One sandbox per user: a persistent workspace and, while warm, a container. */
export const sandboxes = sqliteTable("sandboxes", {
  userId: text("user_id").primaryKey(),
  containerId: text("container_id"), // null when cold — normal, not an error
  workspacePath: text("workspace_path").notNull(),
  image: text("image").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
});

export type SandboxRow = {
  userId: string;
  containerId: string | null;
  workspacePath: string;
  image: string;
  createdAt: number;
  lastUsedAt: number;
};
```

- [ ] **Step 2: Create the table on boot**

In `apps/api/src/db/client.ts`, add to the `ensureSchema()` SQL and re-export:

```sql
CREATE TABLE IF NOT EXISTS sandboxes (
  user_id        TEXT PRIMARY KEY,
  container_id   TEXT,
  workspace_path TEXT NOT NULL,
  image          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_last_used ON sandboxes (last_used_at);
```

Add `sandboxes` to the existing `import { ... } from "../models/schema"` and to the
`export { ... }` list, and add `SandboxRow` to the exported types.

- [ ] **Step 3: Write the failing test**

```ts
// apps/api/src/repositories/sandbox.repository.test.ts
import { expect, test, beforeAll } from "bun:test";
import { ensureSchema } from "../db/client";
import { sandboxRepository } from "./sandbox.repository";

const USER = `test_${Date.now()}`;
beforeAll(() => ensureSchema());

test("upsert then get returns the row", async () => {
  await sandboxRepository.upsert({
    userId: USER, containerId: "c1", workspacePath: "/tmp/ws", image: "img",
  });
  const row = await sandboxRepository.get(USER);
  expect(row?.containerId).toBe("c1");
  expect(row?.workspacePath).toBe("/tmp/ws");
});

test("upsert replaces the container for the same user", async () => {
  await sandboxRepository.upsert({
    userId: USER, containerId: "c2", workspacePath: "/tmp/ws", image: "img",
  });
  const row = await sandboxRepository.get(USER);
  expect(row?.containerId).toBe("c2");
});

test("clearContainer nulls the container but keeps the workspace", async () => {
  await sandboxRepository.clearContainer(USER);
  const row = await sandboxRepository.get(USER);
  expect(row?.containerId).toBeNull();
  expect(row?.workspacePath).toBe("/tmp/ws");
});

test("listIdle finds rows untouched for longer than the window", async () => {
  await sandboxRepository.upsert({
    userId: USER, containerId: "c3", workspacePath: "/tmp/ws", image: "img",
  });
  expect((await sandboxRepository.listIdle(0)).some((r) => r.userId === USER)).toBe(true);
  expect((await sandboxRepository.listIdle(60_000)).some((r) => r.userId === USER)).toBe(false);
});

test("get returns undefined for an unknown user", async () => {
  expect(await sandboxRepository.get("nobody")).toBeUndefined();
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd apps/api && bun test src/repositories/sandbox.repository.test.ts`
Expected: FAIL — cannot resolve `./sandbox.repository`.

- [ ] **Step 5: Implement**

```ts
// apps/api/src/repositories/sandbox.repository.ts
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, sandboxes } from "../db/client";
import type { SandboxRow } from "../models/schema";

/** One sandbox per user. The workspace path outlives every container. */
export const sandboxRepository = {
  async get(userId: string): Promise<SandboxRow | undefined> {
    const rows = await db.select().from(sandboxes).where(eq(sandboxes.userId, userId)).limit(1);
    return rows[0];
  },

  async upsert(input: {
    userId: string;
    containerId: string | null;
    workspacePath: string;
    image: string;
  }): Promise<void> {
    const now = Date.now();
    await db
      .insert(sandboxes)
      .values({ ...input, createdAt: now, lastUsedAt: now })
      .onConflictDoUpdate({
        target: sandboxes.userId,
        set: { containerId: input.containerId, image: input.image, lastUsedAt: now },
      });
  },

  async clearContainer(userId: string): Promise<void> {
    await db
      .update(sandboxes)
      .set({ containerId: null, lastUsedAt: Date.now() })
      .where(eq(sandboxes.userId, userId));
  },

  async touch(userId: string): Promise<void> {
    await db.update(sandboxes).set({ lastUsedAt: Date.now() }).where(eq(sandboxes.userId, userId));
  },

  /** Rows with a live container untouched for longer than `olderThanMs`. */
  async listIdle(olderThanMs: number): Promise<SandboxRow[]> {
    return db
      .select()
      .from(sandboxes)
      .where(and(isNotNull(sandboxes.containerId), lt(sandboxes.lastUsedAt, Date.now() - olderThanMs)));
  },
};
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd apps/api && bun test src/repositories/sandbox.repository.test.ts && bunx tsc --noEmit`
Expected: 5 pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/models/schema.ts apps/api/src/db/client.ts apps/api/src/repositories/sandbox.repository.ts apps/api/src/repositories/sandbox.repository.test.ts
git commit -m "feat: persist per-user sandbox workspace and container"
```

---

## Task 5: Sandbox service

**Files:**
- Create: `apps/api/src/services/sandbox/sandbox.service.ts`
- Test: `apps/api/src/services/sandbox/sandbox.service.test.ts`
- Modify: `apps/api/src/config/env.ts`

**Interfaces:**
- Consumes: Task 2 docker helpers, Task 4 `sandboxRepository`, `env` from config.
- Produces: `sandboxService` with
  `acquire(userId): Promise<{ containerId: string; workspacePath: string }>`,
  `release(userId): Promise<void>`,
  `reapIdle(): Promise<number>` (returns how many were reaped).

- [ ] **Step 1: Add config**

```ts
// apps/api/src/config/env.ts — inside the env object
  /** `node` runs tools on the API host; `docker` runs them in a per-user container. */
  sandboxBackend: (process.env.SANDBOX_BACKEND ?? "node") as "node" | "docker",
  sandboxImage: process.env.SANDBOX_IMAGE ?? "node:22-bookworm-slim",
  sandboxRoot:
    process.env.SANDBOX_ROOT ?? path.join(os.homedir(), "mixmatch-workspaces"),
  sandboxIdleMs: Number(process.env.SANDBOX_IDLE_MS ?? 300_000),
```

Add `import os from "node:os"; import path from "node:path";` at the top of the file.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/services/sandbox/sandbox.service.test.ts
import { expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ensureSchema } from "../../db/client";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import { isRunning } from "./docker";
import { sandboxService } from "./sandbox.service";

const USER = `sbx_${Date.now()}`;
beforeAll(() => ensureSchema());
afterAll(async () => { await sandboxService.destroy(USER); });

test("acquire creates a workspace and a running container", async () => {
  const s = await sandboxService.acquire(USER);
  expect(fs.existsSync(s.workspacePath)).toBe(true);
  expect(await isRunning(s.containerId)).toBe(true);
});

test("acquire reuses a warm container", async () => {
  const a = await sandboxService.acquire(USER);
  const b = await sandboxService.acquire(USER);
  expect(b.containerId).toBe(a.containerId);
});

test("the workspace survives destroying the container", async () => {
  const s = await sandboxService.acquire(USER);
  fs.writeFileSync(path.join(s.workspacePath, "keep.txt"), "kept");
  await sandboxService.destroy(USER);
  expect(fs.existsSync(path.join(s.workspacePath, "keep.txt"))).toBe(true);
  const again = await sandboxService.acquire(USER);
  expect(again.containerId).not.toBe(s.containerId);
  expect(fs.readFileSync(path.join(again.workspacePath, "keep.txt"), "utf8")).toBe("kept");
});

test("reapIdle removes containers past the idle window", async () => {
  await sandboxService.acquire(USER);
  await sandboxService.release(USER);
  const reaped = await sandboxService.reapIdle(0);
  expect(reaped).toBeGreaterThan(0);
  expect((await sandboxRepository.get(USER))?.containerId).toBeNull();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && bun test src/services/sandbox/sandbox.service.test.ts`
Expected: FAIL — cannot resolve `./sandbox.service`.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/services/sandbox/sandbox.service.ts
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { sandboxRepository } from "../../repositories/sandbox.repository";
import { dockerAvailable, ensureImage, isRunning, removeContainer, runDetached } from "./docker";

/** Container names must be filesystem- and DNS-safe. */
const safeName = (userId: string) => `mixmatch-${userId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;

export const sandboxService = {
  /** A running container for this user, creating or restarting one as needed. */
  async acquire(userId: string): Promise<{ containerId: string; workspacePath: string }> {
    if (!(await dockerAvailable())) {
      throw new Error(
        "Docker isn't reachable. Start Docker Desktop, or set SANDBOX_BACKEND=node to run tools on the API host.",
      );
    }

    const existing = await sandboxRepository.get(userId);
    const workspacePath = existing?.workspacePath ?? path.join(env.sandboxRoot, userId);
    fs.mkdirSync(workspacePath, { recursive: true });

    if (existing?.containerId && (await isRunning(existing.containerId))) {
      await sandboxRepository.touch(userId);
      return { containerId: existing.containerId, workspacePath };
    }

    // Stale row, or first run: drop any dead container and start fresh.
    if (existing?.containerId) await removeContainer(existing.containerId);
    await removeContainer(safeName(userId)); // reap an orphan from a previous process

    await ensureImage(env.sandboxImage);
    const containerId = await runDetached({
      image: env.sandboxImage,
      workspacePath,
      name: safeName(userId),
    });
    await sandboxRepository.upsert({
      userId, containerId, workspacePath, image: env.sandboxImage,
    });
    logger.info("sandbox.started", { user: userId, container: containerId.slice(0, 12) });
    return { containerId, workspacePath };
  },

  /** Mark the sandbox idle. The container stays warm until reaped. */
  async release(userId: string): Promise<void> {
    await sandboxRepository.touch(userId);
  },

  /** Stop containers idle beyond the window. Workspaces are never touched. */
  async reapIdle(olderThanMs: number = env.sandboxIdleMs): Promise<number> {
    const idle = await sandboxRepository.listIdle(olderThanMs);
    for (const row of idle) {
      if (row.containerId) await removeContainer(row.containerId);
      await sandboxRepository.clearContainer(row.userId);
      logger.info("sandbox.reaped", { user: row.userId });
    }
    return idle.length;
  },

  /** Remove this user's container immediately. The workspace is kept. */
  async destroy(userId: string): Promise<void> {
    const row = await sandboxRepository.get(userId);
    if (row?.containerId) await removeContainer(row.containerId);
    await removeContainer(safeName(userId));
    if (row) await sandboxRepository.clearContainer(userId);
  },
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && bun test src/services/sandbox/sandbox.service.test.ts && bunx tsc --noEmit`
Expected: 4 pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/sandbox/sandbox.service.ts apps/api/src/services/sandbox/sandbox.service.test.ts apps/api/src/config/env.ts
git commit -m "feat: sandbox lifecycle service with warm reuse and idle reaping"
```

---

## Task 6: Wire the sandbox into the agent

**Files:**
- Modify: `apps/api/src/services/pi.service.ts`

**Interfaces:**
- Consumes: `sandboxService` (Task 5), `DockerExecutionEnv` (Task 3), `env` config.
- Produces: no new exports. Behaviour change only, gated on `SANDBOX_BACKEND`.

- [ ] **Step 1: Replace the env construction**

Find this block in `pi.service.ts` (around line 95):

```ts
const workspaceDir = workspace ?? path.resolve(process.cwd(), "workspace");
fs.mkdirSync(workspaceDir, { recursive: true });
const env = new NodeExecutionEnv({ cwd: workspaceDir });
```

Replace with:

```ts
// The agent's world: the API host's own filesystem, or a per-user container.
let execEnv: ExecutionEnv;
let releaseSandbox: (() => Promise<void>) | undefined;

if (appEnv.sandboxBackend === "docker") {
  const sandbox = await sandboxService.acquire(userId);
  execEnv = new DockerExecutionEnv({
    containerId: sandbox.containerId,
    cwd: sandbox.workspacePath,
  });
  releaseSandbox = () => sandboxService.release(userId);
} else {
  const workspaceDir = workspace ?? path.resolve(process.cwd(), "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  execEnv = new NodeExecutionEnv({ cwd: workspaceDir });
}
```

Add these imports at the top:

```ts
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { env as appEnv } from "../config/env";
import { DockerExecutionEnv } from "./sandbox/docker-execution-env";
import { sandboxService } from "./sandbox/sandbox.service";
```

The existing local `const env` name collides with the config import, which is why
the config is aliased to `appEnv` and the execution env renamed to `execEnv`.

- [ ] **Step 2: Update the two references to the old name**

`toolContext: { env }` becomes `toolContext: { env: execEnv }`.
In the `finally` block, `await env.cleanup()` becomes:

```ts
await execEnv.cleanup().catch(() => {});
await releaseSandbox?.().catch(() => {});
```

- [ ] **Step 3: Verify both backends typecheck and the default is unchanged**

Run: `cd apps/api && bunx tsc --noEmit`
Expected: clean.

Run: `cd apps/api && bun test`
Expected: all previous tests still pass.

- [ ] **Step 4: Verify the node backend still works end to end**

Start the API and web, send "create a file called hello.txt containing hi, then
read it back". Expected: it works exactly as before, and the file appears in
`apps/api/workspace/`. This confirms the change is inert by default.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pi.service.ts
git commit -m "feat: run agent tools in a sandbox when SANDBOX_BACKEND=docker"
```

---

## Task 7: End-to-end verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the answer to the spike's question.

- [ ] **Step 1: Run the API with the docker backend**

```bash
cd apps/api && SANDBOX_BACKEND=docker SANDBOX_IDLE_MS=5000 bun run dev
```

- [ ] **Step 2: First agent — create a file**

In the browser, ask: `Create a file called report.txt containing the word alpha, then show me the contents.`

Expected: the agent uses `bash` or `write`, and `~/mixmatch-workspaces/<user>/report.txt` appears on the host. Confirm in Finder.

- [ ] **Step 3: Destroy the container**

```bash
docker ps --filter name=mixmatch- --format '{{.Names}}'   # note the name
docker rm -f <name>
```

- [ ] **Step 4: Second agent — read and modify it**

Ask a **new** agent: `Read report.txt and append the word beta to it.`

Expected: a new container starts, the agent reads `alpha`, and the file becomes `alpha` + `beta`.

- [ ] **Step 5: Destroy again, then a third agent**

Repeat step 3, then ask a third agent: `What is in report.txt?`

Expected: it reports both `alpha` and `beta`. **This second cycle is the criterion** — it is the case that failed for E2B in issue #884.

- [ ] **Step 6: Confirm the API host is untouched**

```bash
ls apps/api/workspace/
```

Expected: `report.txt` is NOT there. The agent never touched the API server's filesystem.

- [ ] **Step 7: Document it**

Add to `README.md` under Architecture:

```markdown
### Sandboxed workspaces

With `SANDBOX_BACKEND=docker`, the agent's `bash`/`read`/`write`/`edit` tools run
inside a per-user Docker container instead of on the API host. The user's
workspace lives at `SANDBOX_ROOT/<userId>` and is bind-mounted into the container
at the same absolute path, so host and container share one path namespace.

Containers are started on demand, reused while warm, and removed after
`SANDBOX_IDLE_MS` of inactivity. **Workspaces are never deleted.**

| Var | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_BACKEND` | `node` | `node` (API host) or `docker` (per-user container) |
| `SANDBOX_IMAGE` | `node:22-bookworm-slim` | Image the agent works inside |
| `SANDBOX_ROOT` | `~/mixmatch-workspaces` | Where workspaces live on the host |
| `SANDBOX_IDLE_MS` | `300000` | Remove a container after this much idle time |

Requires a running Docker daemon. With `SANDBOX_BACKEND=docker` and Docker down,
runs fail with a clear message rather than silently falling back to the host.
```

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: document sandboxed agent workspaces"
```

---

## Self-review notes

**Spec coverage:** every component in the spec's table maps to a task — `docker.ts` (2), `docker-execution-env.ts` (3), `sandbox.repository.ts` + schema (4), `sandbox.service.ts` + config (5), `pi.service.ts` (6). The spec's testing section maps to Task 1 (script), Tasks 2–5 (unit), Task 7 (e2e). All six success criteria are checked in Task 7.

**Known deviation from the spec:** the spec's component table named `container.ts` using `dockerode`; probing showed `dockerode` exec is broken under Bun, so the plan uses `docker.ts` over the Docker CLI. The spec was updated to match before this plan was written.

**Deferred, deliberately:** the sandbox-state indicator in the UI. Cold start is visible (~1–2s on first message) and the spec lists a UI state as a follow-up, not a spike requirement. Task 7 exposes whether it is actually needed.

**Not covered, by design:** auth, quotas, billing, channels, E2B, S3, multi-host. Listed as out of scope in the spec.
