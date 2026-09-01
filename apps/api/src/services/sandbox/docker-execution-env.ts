import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import nodePath from "node:path";
import { execArgvInContainer, execInContainer } from "./docker";

type FsReply =
  | { ok: true; value?: unknown }
  | { ok: false; code: FileError["code"]; message: string; path?: string };

/**
 * Filesystem adapter executed inside the sandbox container.
 *
 * A host-side adapter cannot safely follow workspace symlinks: a link created
 * by the agent to `/etc/passwd` would resolve against the API host, not the
 * container. Keeping every file operation inside Docker makes links resolve in
 * the sandbox's namespace and removes that host escape entirely.
 */
const FILE_HELPER = String.raw`
import base64, json, os, shutil, stat, sys, tempfile

op = sys.argv[1]
req = json.load(sys.stdin)
path = req.get("path")

def info(target):
    value = os.lstat(target)
    mode = value.st_mode
    kind = "symlink" if stat.S_ISLNK(mode) else "directory" if stat.S_ISDIR(mode) else "file"
    return {"name": os.path.basename(target), "path": os.path.normpath(target), "kind": kind,
            "size": value.st_size, "mtimeMs": value.st_mtime * 1000}

try:
    if op == "read_text":
        with open(path, "r", encoding="utf-8") as handle: value = handle.read()
    elif op == "read_lines":
        maximum = req.get("maxLines")
        value = []
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                if maximum is not None and len(value) >= maximum: break
                value.append(line.rstrip("\n").rstrip("\r"))
    elif op == "read_binary":
        with open(path, "rb") as handle: value = base64.b64encode(handle.read()).decode("ascii")
    elif op in ("write", "append"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "ab" if op == "append" else "wb") as handle:
            handle.write(base64.b64decode(req["content"]))
        value = None
    elif op == "info": value = info(path)
    elif op == "list": value = [info(os.path.join(path, name)) for name in os.listdir(path)]
    elif op == "canonical": value = os.path.realpath(path, strict=True)
    elif op == "exists":
        try: os.lstat(path); value = True
        except FileNotFoundError: value = False
    elif op == "mkdir":
        if req.get("recursive", True): os.makedirs(path, exist_ok=True)
        else: os.mkdir(path)
        value = None
    elif op == "remove":
        try:
            mode = os.lstat(path).st_mode
        except FileNotFoundError:
            if req.get("force", False): value = None
            else: raise
        else:
            if stat.S_ISDIR(mode) and not stat.S_ISLNK(mode):
                shutil.rmtree(path) if req.get("recursive", False) else os.rmdir(path)
            else: os.unlink(path)
            value = None
    elif op == "temp_dir": value = tempfile.mkdtemp(prefix=req.get("prefix", "tmp-"), dir=req["cwd"])
    elif op == "temp_file":
        fd, value = tempfile.mkstemp(prefix=req.get("prefix", ""), suffix=req.get("suffix", ""), dir=req["cwd"])
        os.close(fd)
    else: raise ValueError("unsupported filesystem operation")
    print(json.dumps({"ok": True, "value": value}))
except FileNotFoundError as error: print(json.dumps({"ok": False, "code": "not_found", "message": str(error), "path": path}))
except PermissionError as error: print(json.dumps({"ok": False, "code": "permission_denied", "message": str(error), "path": path}))
except NotADirectoryError as error: print(json.dumps({"ok": False, "code": "not_directory", "message": str(error), "path": path}))
except IsADirectoryError as error: print(json.dumps({"ok": False, "code": "is_directory", "message": str(error), "path": path}))
except ValueError as error: print(json.dumps({"ok": False, "code": "invalid", "message": str(error), "path": path}))
except Exception as error: print(json.dumps({"ok": False, "code": "unknown", "message": str(error), "path": path}))
`;

export class DockerExecutionEnv extends NodeExecutionEnv {
  private readonly containerId: string;

  constructor(options: { containerId: string; cwd: string }) {
    super({ cwd: options.cwd });
    this.containerId = options.containerId;
  }

  override async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const outcome = await execInContainer(this.containerId, command, {
      cwd: options.cwd ?? this.cwd,
      env: options.env,
      timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
      signal: options.abortSignal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });

    switch (outcome.kind) {
      case "ok": return ok(outcome.result);
      case "timeout": return err(new ExecutionError("timeout", `Command timed out: ${command}`));
      case "aborted": return err(new ExecutionError("aborted", `Command aborted: ${command}`));
      case "spawn_error": return err(new ExecutionError("spawn_error", outcome.message));
    }
  }

  private resolved(path: string): Result<string, FileError> {
    const resolved = nodePath.resolve(this.cwd, path);
    const relative = nodePath.relative(this.cwd, resolved);
    if (relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative))) {
      return ok<string, FileError>(resolved);
    }
    return err<string, FileError>(new FileError(
      "permission_denied",
      `Path is outside the sandbox workspace (${this.cwd}). Only files inside the workspace are reachable.`,
      resolved,
    ));
  }

  private async fileCall<T>(
    operation: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result<T, FileError>> {
    if (signal?.aborted) return err<T, FileError>(new FileError("aborted", "aborted", String(request.path ?? "")));
    const outcome = await execArgvInContainer(
      this.containerId,
      ["python3", "-c", FILE_HELPER, operation],
      { cwd: this.cwd, stdin: JSON.stringify(request), signal },
    );
    if (outcome.kind === "aborted") return err<T, FileError>(new FileError("aborted", "aborted", String(request.path ?? "")));
    if (outcome.kind !== "ok") {
      return err<T, FileError>(new FileError("unknown", `Docker filesystem operation failed: ${outcome.kind}`, String(request.path ?? "")));
    }
    if (outcome.result.exitCode !== 0) {
      return err<T, FileError>(new FileError("unknown", outcome.result.stderr.trim() || "Docker filesystem helper failed", String(request.path ?? "")));
    }
    let reply: FsReply;
    try {
      reply = JSON.parse(outcome.result.stdout) as FsReply;
    } catch {
      return err<T, FileError>(new FileError("unknown", "Docker filesystem helper returned invalid JSON", String(request.path ?? "")));
    }
    if (!reply.ok) return err<T, FileError>(new FileError(reply.code, reply.message, reply.path));
    return ok<T, FileError>(reply.value as T);
  }

  override async absolutePath(path: string) { return this.resolved(path); }
  override async joinPath(parts: string[]) { return this.resolved(nodePath.join(...parts)); }

  override async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<string, FileError>(resolved.error);
    return this.fileCall<string>("read_text", { path: resolved.value }, abortSignal);
  }

  override async readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }): Promise<Result<string[], FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<string[], FileError>(resolved.error);
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok<string[], FileError>([]);
    return this.fileCall<string[]>("read_lines", { path: resolved.value, maxLines: options?.maxLines }, options?.abortSignal);
  }

  override async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<Uint8Array, FileError>(resolved.error);
    const encoded = await this.fileCall<string>("read_binary", { path: resolved.value }, abortSignal);
    return encoded.ok
      ? ok<Uint8Array, FileError>(Uint8Array.from(Buffer.from(encoded.value, "base64")))
      : err<Uint8Array, FileError>(encoded.error);
  }

  override async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    return this.write("write", path, content, abortSignal);
  }

  override async appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    return this.write("append", path, content, abortSignal);
  }

  private async write(operation: string, path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<void, FileError>(resolved.error);
    const bytes = Buffer.from(content);
    return this.fileCall<void>(operation, { path: resolved.value, content: bytes.toString("base64") }, signal);
  }

  override async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<FileInfo, FileError>(resolved.error);
    return this.fileCall<FileInfo>("info", { path: resolved.value }, abortSignal);
  }

  override async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<FileInfo[], FileError>(resolved.error);
    return this.fileCall<FileInfo[]>("list", { path: resolved.value }, abortSignal);
  }

  override async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<string, FileError>(resolved.error);
    const canonical = await this.fileCall<string>("canonical", { path: resolved.value }, abortSignal);
    return canonical.ok ? this.resolved(canonical.value) : err<string, FileError>(canonical.error);
  }

  override async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<boolean, FileError>(resolved.error);
    return this.fileCall<boolean>("exists", { path: resolved.value }, abortSignal);
  }

  override async createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<void, FileError>(resolved.error);
    return this.fileCall<void>("mkdir", { path: resolved.value, recursive: options?.recursive ?? true }, options?.abortSignal);
  }

  override async remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>> {
    const resolved = this.resolved(path);
    if (!resolved.ok) return err<void, FileError>(resolved.error);
    return this.fileCall<void>("remove", {
      path: resolved.value,
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    }, options?.abortSignal);
  }

  override async createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileCall<string>("temp_dir", { cwd: this.cwd, prefix }, abortSignal);
  }

  override async createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }): Promise<Result<string, FileError>> {
    return this.fileCall<string>("temp_file", {
      cwd: this.cwd,
      prefix: options?.prefix ?? "",
      suffix: options?.suffix ?? "",
    }, options?.abortSignal);
  }
}
