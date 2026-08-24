import path from "node:path/posix";
import {
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type Result,
  type ShellExecOptions,
  err,
  ok,
} from "@earendil-works/pi-agent-core";
import { PixelboxError, type PixelboxFileKind, type SandboxApi } from "./pixelbox-client";
import { PYTHON_RUNTIME_ENV } from "./python-baseline";

/**
 * The agent's world, relocated into a remote gVisor sandbox.
 *
 * This is the Pixelbox counterpart to `DockerExecutionEnv`. The crucial difference:
 * `DockerExecutionEnv` ran filesystem operations on the *host* and leaned on a
 * bind mount at an identical path for that to be equivalent to the container —
 * so it had to `guard()` every path itself against escaping the workspace. Here
 * nothing runs on the host: shell and filesystem both go over HTTPS to the pod,
 * and the *service* confines every path to `/workspace` and `/tmp` (it answers
 * an escape with `INVALID_PATH`). The confinement is therefore server-side, and
 * this class only resolves relative paths against {@link cwd} before sending.
 *
 * Swapping backends is one more class against the same `ExecutionEnv` interface;
 * nothing else in the app knows which one it holds.
 */
export class PixelboxExecutionEnv {
  readonly cwd: string;
  private readonly api: SandboxApi;
  private readonly sandboxId: string;
  private readonly ownsSandbox: boolean;

  constructor(options: {
    api: SandboxApi;
    sandboxId: string;
    cwd?: string;
    /** When true, {@link cleanup} deletes the sandbox; otherwise it detaches. */
    ownsSandbox?: boolean;
  }) {
    this.api = options.api;
    this.sandboxId = options.sandboxId;
    this.cwd = options.cwd ?? "/workspace";
    this.ownsSandbox = options.ownsSandbox ?? false;
  }

  /** Resolve a caller path against cwd. Absolute paths pass through unchanged. */
  private resolve(p: string): string {
    return path.resolve(this.cwd, p);
  }

  // ---- Shell -------------------------------------------------------------

  async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", `Command aborted: ${command}`));
    }

    let result;
    try {
      result = await this.api.execute(
        this.sandboxId,
        {
          command,
          cwd: this.resolve(options.cwd ?? this.cwd),
          env: { ...PYTHON_RUNTIME_ENV, ...options.env },
          timeoutSeconds: options.timeout,
        },
        options.abortSignal,
      );
    } catch (e) {
      if (e instanceof PixelboxError) {
        if (e.code === "EXEC_TIMEOUT") return err(new ExecutionError("timeout", e.message));
        return err(new ExecutionError("spawn_error", e.message));
      }
      if ((e as Error)?.name === "AbortError" || options.abortSignal?.aborted) {
        return err(new ExecutionError("aborted", `Command aborted: ${command}`));
      }
      return err(new ExecutionError("unknown", (e as Error)?.message ?? String(e)));
    }

    // No streaming from the service yet: deliver the final output once, which is
    // still what the read/bash tools render. Live partial output waits on a
    // server process-stream capability (see the handover doc).
    if (result.stdout) options.onStdout?.(result.stdout);
    if (result.stderr) options.onStderr?.(result.stderr);

    if (result.timedOut) {
      return err(new ExecutionError("timeout", `Command timed out: ${command}`));
    }
    return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  }

  // ---- FileSystem --------------------------------------------------------

  async absolutePath(p: string): Promise<Result<string, FileError>> {
    return ok(this.resolve(p));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(path.join(...parts));
  }

  /** The service resolves symlinks server-side; without a dedicated primitive
   * the honest canonical form we can offer is the normalized absolute path. */
  async canonicalPath(p: string): Promise<Result<string, FileError>> {
    return ok(this.resolve(p));
  }

  async readTextFile(p: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    try {
      const bytes = await this.api.readBytes(this.sandboxId, this.resolve(p), abortSignal);
      return ok(new TextDecoder().decode(bytes));
    } catch (e) {
      return err(toFileError(e, this.resolve(p)));
    }
  }

  async readTextLines(
    p: string,
    options: { maxLines?: number; abortSignal?: AbortSignal } = {},
  ): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(p, options.abortSignal);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    // A trailing newline yields a final empty element that is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return ok(options.maxLines != null ? lines.slice(0, options.maxLines) : lines);
  }

  async readBinaryFile(p: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    try {
      return ok(await this.api.readBytes(this.sandboxId, this.resolve(p), abortSignal));
    } catch (e) {
      return err(toFileError(e, this.resolve(p)));
    }
  }

  async writeFile(
    p: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    try {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      await this.api.writeBytes(this.sandboxId, this.resolve(p), bytes, abortSignal);
      return ok(undefined);
    } catch (e) {
      return err(toFileError(e, this.resolve(p)));
    }
  }

  /** No remote append primitive: read the current bytes and rewrite. */
  async appendFile(p: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const abs = this.resolve(p);
    const add = typeof content === "string" ? new TextEncoder().encode(content) : content;
    let existing: Uint8Array = new Uint8Array(0);
    try {
      existing = await this.api.readBytes(this.sandboxId, abs);
    } catch (e) {
      // Appending to a missing file creates it; any other error is real.
      if (!(e instanceof PixelboxError) || e.code !== "NOT_FOUND") return err(toFileError(e, abs));
    }
    const merged = new Uint8Array(existing.length + add.length);
    merged.set(existing, 0);
    merged.set(add, existing.length);
    try {
      await this.api.writeBytes(this.sandboxId, abs, merged);
      return ok(undefined);
    } catch (e) {
      return err(toFileError(e, abs));
    }
  }

  async fileInfo(p: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const abs = this.resolve(p);
    try {
      const info = await this.api.stat(this.sandboxId, abs, abortSignal);
      if (!info) return err(new FileError("not_found", `No such file: ${abs}`, abs));
      return ok({
        name: path.basename(abs),
        path: abs,
        kind: toFileKind(info.kind),
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    } catch (e) {
      return err(toFileError(e, abs));
    }
  }

  async listDir(p: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const abs = this.resolve(p);
    try {
      const entries = await this.api.list(this.sandboxId, abs, abortSignal);
      return ok(
        entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: toFileKind(entry.kind),
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        })),
      );
    } catch (e) {
      return err(toFileError(e, abs));
    }
  }

  async exists(p: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    try {
      const info = await this.api.stat(this.sandboxId, this.resolve(p), abortSignal);
      return ok(info !== null);
    } catch (e) {
      return err(toFileError(e, this.resolve(p)));
    }
  }

  async createDir(
    p: string,
    options: { recursive?: boolean; abortSignal?: AbortSignal } = {},
  ): Promise<Result<void, FileError>> {
    try {
      await this.api.createDir(this.sandboxId, this.resolve(p), options.recursive ?? true, options.abortSignal);
      return ok(undefined);
    } catch (e) {
      return err(toFileError(e, this.resolve(p)));
    }
  }

  async remove(
    p: string,
    options: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } = {},
  ): Promise<Result<void, FileError>> {
    try {
      await this.api.remove(
        this.sandboxId,
        this.resolve(p),
        { recursive: options.recursive, force: options.force },
        options.abortSignal,
      );
      return ok(undefined);
    } catch (e) {
      return err(toFileError(e, this.resolve(p)));
    }
  }

  async createTempDir(prefix = "tmp-"): Promise<Result<string, FileError>> {
    return this.mktemp(["-d", `/tmp/${sanitizeTempPrefix(prefix)}XXXXXXXXXX`]);
  }

  async createTempFile(options: { prefix?: string; suffix?: string } = {}): Promise<Result<string, FileError>> {
    const args = [`/tmp/${sanitizeTempPrefix(options.prefix ?? "")}XXXXXXXXXX`];
    if (options.suffix) args.unshift("--suffix", options.suffix);
    return this.mktemp(args);
  }

  /** Temporary paths have no file API; the sandbox's own `mktemp` mints them. */
  private async mktemp(args: string[]): Promise<Result<string, FileError>> {
    const command = ["mktemp", ...args.map(shellQuote)].join(" ");
    const result = await this.exec(command);
    if (!result.ok) return err(new FileError("unknown", result.error.message));
    if (result.value.exitCode !== 0) {
      return err(new FileError("unknown", result.value.stderr.trim() || "mktemp failed"));
    }
    return ok(result.value.stdout.trim());
  }

  async cleanup(): Promise<void> {
    if (!this.ownsSandbox) return;
    try {
      await this.api.delete(this.sandboxId);
    } catch {
      // Best-effort by contract: cleanup must never throw or reject.
    }
  }
}

function toFileKind(kind: PixelboxFileKind): FileKind {
  return kind === "dir" ? "directory" : kind;
}

function toFileError(e: unknown, path: string): FileError {
  if (e instanceof FileError) return e;
  if (e instanceof PixelboxError) {
    const code: FileErrorCode =
      e.code === "NOT_FOUND"
        ? "not_found"
        : e.code === "INVALID_PATH"
          ? "permission_denied"
          : e.code === "INVALID_ARGUMENT"
            ? "invalid"
            : "unknown";
    return new FileError(code, e.message, path);
  }
  return new FileError("unknown", (e as Error)?.message ?? String(e), path);
}

/** Keep a caller-supplied temp prefix from carrying path separators or spaces. */
function sanitizeTempPrefix(prefix: string): string {
  return prefix.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/** Single-quote an argv token for the remote shell. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}
