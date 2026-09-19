import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Fixed in-container path for the read-only skills mount. */
export const SKILLS_MOUNT = "/skills";

/**
 * Docker via its CLI rather than an SDK.
 *
 * `dockerode` is the obvious choice and does not work here: its exec path needs
 * an HTTP 101 upgrade that `docker-modem` mishandles under Bun, and even when it
 * connects it hands back a multiplexed stream that needs manual de-framing plus
 * a second call for the exit code. `docker exec` via `spawn` gives separate
 * stdout/stderr and a real exit status for free.
 *
 * Every call passes an argv array — never a shell string — so paths and
 * container names carrying spaces or quotes cannot be misread as syntax.
 */

export type DockerExec = { stdout: string; stderr: string; exitCode: number };

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  stdin?: string | Uint8Array;
  abortCleanup?: () => Promise<void>;
};

export type ExecOutcome =
  | { kind: "ok"; result: DockerExec }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "spawn_error"; message: string };

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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const kill = () => child.kill("SIGKILL");
    const claim = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const finish = (outcome: ExecOutcome) => {
      if (!claim()) return;
      resolve(outcome);
    };
    async function onAbort() {
      if (!claim()) return;
      kill();
      try {
        await options.abortCleanup?.();
      } finally {
        resolve({ kind: "aborted" });
      }
    }

    if (options.signal?.aborted) {
      void onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        kill();
        finish({ kind: "timeout" });
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (d) => {
      const chunk = String(d);
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (d) => {
      const chunk = String(d);
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);
    child.on("error", (e) => finish({ kind: "spawn_error", message: e.message }));
    child.on("close", (code) =>
      finish({ kind: "ok", result: { stdout, stderr, exitCode: code ?? -1 } }),
    );
  });
}

/** For control-plane calls where anything but a clean run is a bug. */
async function plain(args: string[], timeoutMs = 30_000): Promise<DockerExec> {
  const outcome = await docker(args, { timeoutMs });
  if (outcome.kind !== "ok") {
    throw new Error(`docker ${args[0]} did not complete: ${outcome.kind}`);
  }
  return outcome.result;
}

export async function dockerAvailable(): Promise<boolean> {
  const outcome = await docker(["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 5_000,
  });
  return outcome.kind === "ok" && outcome.result.exitCode === 0;
}

/** Pull the image only when it isn't already local. */
export async function ensureImage(image: string): Promise<void> {
  const found = await plain(["images", "-q", image]);
  if (found.stdout.trim()) return;

  const pulled = await docker(["pull", image], { timeoutMs: 600_000 });
  if (pulled.kind !== "ok" || pulled.result.exitCode !== 0) {
    const detail = pulled.kind === "ok" ? pulled.result.stderr.trim() : pulled.kind;
    throw new Error(`Could not pull image ${image}: ${detail}`);
  }
}

/**
 * Start a detached container whose workspace is bind-mounted at the SAME
 * absolute path it occupies on the host. The shared namespace lets uploads and
 * generated artifacts cross the boundary, while filesystem operations still
 * execute inside the container so sandbox symlinks cannot reach the API host.
 */
export async function runDetached(options: {
  image: string;
  workspacePath: string;
  name: string;
  /** Host skills directory, mounted read-only at {@link SKILLS_MOUNT}. */
  skillsPath?: string;
}): Promise<string> {
  const result = await plain([
    "run",
    "-d",
    "--name",
    options.name,
    "--label",
    "com.pixelspace.sandbox=1",
    "-v",
    `${options.workspacePath}:${options.workspacePath}`,
    // Skills are mounted at a fixed path so a skill's `run` command does not
    // depend on where the repository happens to sit on the host, and read-only
    // so the agent cannot rewrite the code it is about to execute.
    ...(options.skillsPath ? ["-v", `${options.skillsPath}:${SKILLS_MOUNT}:ro`] : []),
    "-w",
    options.workspacePath,
    options.image,
    "sleep",
    "infinity",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`docker run failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function isRunning(containerId: string): Promise<boolean> {
  const result = await plain(["inspect", "-f", "{{.State.Running}}", containerId]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Remove a container by id or name. Missing containers are not an error. */
export async function removeContainer(containerId: string): Promise<void> {
  const outcome = await docker(["rm", "-f", containerId], { timeoutMs: 30_000 });
  if (outcome.kind !== "ok") {
    throw new Error(`docker rm did not complete: ${outcome.kind}`);
  }
  if (outcome.result.exitCode !== 0 && !outcome.result.stderr.includes("No such container")) {
    throw new Error(`docker rm failed: ${outcome.result.stderr.trim()}`);
  }
}

export function execInContainer(
  containerId: string,
  command: string,
  options: ExecOptions = {},
): Promise<ExecOutcome> {
  const commandArgs = options.timeoutMs
    ? [
        "timeout",
        "--signal=KILL",
        "--kill-after=1s",
        `${Math.max(0.001, options.timeoutMs / 1_000)}s`,
        "bash",
        "-lc",
        command,
      ]
    : ["bash", "-lc", command];
  return execArgvInContainer(containerId, commandArgs, options).then((outcome) => {
    if (
      options.timeoutMs &&
      outcome.kind === "ok" &&
      (outcome.result.exitCode === 124 || outcome.result.exitCode === 137)
    ) {
      return { kind: "timeout" } as const;
    }
    return outcome;
  });
}

/**
 * The shell that runs one command under a pid file, so an abort can kill it.
 *
 * `setsid` puts the command in a new session and the pid file carries its
 * process-group id, so `abortCleanup` can `kill -KILL -- -$pid` the whole group
 * rather than the leader alone. The command runs in the background to learn that
 * pid, and a non-interactive bash assigns `/dev/null` to a background job's stdin
 * *before* any explicit redirection — so the filesystem helper, which reads its
 * request from stdin, was handed an empty one and every read and write failed
 * with `JSONDecodeError: Expecting value`, leaving the model to fall back on
 * `bash`. Duplicating stdin to fd 3 first and redirecting the job from it keeps
 * the request readable. A command with no stdin has nothing to preserve, and
 * `/dev/null` is what it should see.
 */
export function cancellationWrapper(pidFile: string, hasStdin: boolean): string {
  const run = hasStdin ? 'exec 3<&0; setsid "$@" <&3 &' : 'setsid "$@" &';
  return `pid_file="$1"; shift; ${run} pid=$!; printf "%s\\n" "$pid" > "$pid_file"; wait "$pid"; status=$?; rm -f "$pid_file"; exit "$status"`;
}

/** Execute an argv vector without involving a shell. */
export function execArgvInContainer(
  containerId: string,
  commandArgs: string[],
  options: ExecOptions = {},
): Promise<ExecOutcome> {
  const pidFile = options.signal ? `/tmp/pixelspace-exec-${randomUUID()}.pid` : undefined;
  const trackedCommandArgs = pidFile
    ? [
        "bash",
        "-c",
        cancellationWrapper(pidFile, options.stdin !== undefined),
        "pixelspace-exec",
        pidFile,
        ...commandArgs,
      ]
    : commandArgs;
  const args = ["exec"];
  if (options.stdin !== undefined) args.push("-i");
  if (options.cwd) args.push("-w", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  // The tool is named "bash", so run bash: on Debian `/bin/sh` is dash, and the
  // model writes bashisms (here-strings, `[[ ]]`) that dash rejects with an
  // opaque "Syntax error" (measured in the DGX traces). bash ships in the
  // sandbox image; falls through to sh only if it were ever absent.
  args.push(containerId, ...trackedCommandArgs);

  const abortCleanup = pidFile
    ? async () => {
        await docker(
          [
            "exec",
            containerId,
            "bash",
            "-c",
            'i=0; while [ "$i" -lt 25 ] && [ ! -s "$1" ]; do sleep 0.02; i=$((i + 1)); done; if [ -s "$1" ]; then pid=$(cat "$1"); kill -KILL -- "-$pid" 2>/dev/null || true; rm -f "$1"; fi',
            "pixelspace-cancel",
            pidFile,
          ],
          { timeoutMs: 2_000 },
        );
      }
    : undefined;

  return docker(args, {
    ...options,
    // The in-container timeout owns command termination. This outer deadline
    // is only a backstop for a wedged Docker client/daemon.
    timeoutMs: options.timeoutMs ? options.timeoutMs + 2_000 : undefined,
    abortCleanup,
  });
}
