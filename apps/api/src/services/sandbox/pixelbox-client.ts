/**
 * Client for the Pixelbox remote Sandbox API (ADR 0003).
 *
 * This replaces the local Docker backend: shell and filesystem operations that
 * used to run in a sibling container now run in a remote gVisor pod reached over
 * HTTPS. See `docs/sandbox/instruction.md` for the service contract and
 * `pixelbox-execution-env.ts` for the Pi `ExecutionEnv` built on top of this.
 *
 * The northbound HTTP shape differs from the SDK sketch in the handover doc:
 * create takes a FLAT body plus an `Idempotency-Key` header, a live sandbox
 * reports state `"ready"`, and every file operation lives under `/files/*`.
 * Those facts were confirmed against the running service, not the doc.
 */

/** A running-equivalent sandbox reports one of these. `ready` is the live state. */
export type SandboxState = "created" | "ready" | "running" | "finished" | "error";

export type SandboxInfo = {
  sandboxId: string;
  state: SandboxState;
};

export type CreateOptions = {
  timeoutSeconds?: number;
  cpu?: number;
  memoryMiB?: number;
  workspaceMiB?: number;
  /**
   * Deny outbound network from inside the sandbox. Egress is OPEN by default on
   * the service, so the safe stance for an agent running untrusted, possibly
   * prompt-injected work is to block it unless a run needs it.
   */
  blockNetwork?: boolean;
  tags?: Record<string, string>;
};

export type ExecRequest = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

/** Kind as the service reports it: `dir` maps to Pi's `directory`. */
export type PixelboxFileKind = "file" | "dir" | "symlink";

export type StatInfo = {
  kind: PixelboxFileKind;
  size: number;
  mtimeMs: number;
};

export type ListEntry = StatInfo & {
  name: string;
  path: string;
};

/** Stable codes the service returns in its problem+json `code` field. */
export type PixelboxErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "SANDBOX_UNAVAILABLE"
  | "SANDBOX_EXPIRED"
  | "EXEC_TIMEOUT"
  | "EXEC_TRANSPORT_ERROR"
  | "UNSUPPORTED_FEATURE"
  | "UNKNOWN";

export class PixelboxError extends Error {
  constructor(
    readonly code: PixelboxErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PixelboxError";
  }
}

/**
 * The subset of the Sandbox API the execution env depends on.
 *
 * An interface, not the concrete client, so the execution env can be driven by
 * an in-memory fake in tests without a live service — the same reason
 * `DockerExecutionEnv` was awkward to test and this is not.
 */
export interface SandboxApi {
  create(options?: CreateOptions): Promise<SandboxInfo>;
  get(sandboxId: string): Promise<SandboxInfo>;
  delete(sandboxId: string): Promise<void>;
  execute(sandboxId: string, req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  /** Read raw bytes. Throws {@link PixelboxError} `NOT_FOUND` when the path is absent. */
  readBytes(sandboxId: string, path: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeBytes(sandboxId: string, path: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Metadata, or `null` when the path does not exist (a 404 is not an error here). */
  stat(sandboxId: string, path: string, signal?: AbortSignal): Promise<StatInfo | null>;
  list(sandboxId: string, path: string, signal?: AbortSignal): Promise<ListEntry[]>;
  createDir(sandboxId: string, path: string, recursive: boolean, signal?: AbortSignal): Promise<void>;
  remove(
    sandboxId: string,
    path: string,
    options: { recursive?: boolean; force?: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Map an HTTP status + optional problem `code` to a stable {@link PixelboxErrorCode}. */
function classify(status: number, code?: string): PixelboxErrorCode {
  const known: PixelboxErrorCode[] = [
    "INVALID_ARGUMENT",
    "INVALID_PATH",
    "NOT_FOUND",
    "SANDBOX_UNAVAILABLE",
    "SANDBOX_EXPIRED",
    "EXEC_TIMEOUT",
    "EXEC_TRANSPORT_ERROR",
    "UNSUPPORTED_FEATURE",
  ];
  if (code && known.includes(code as PixelboxErrorCode)) return code as PixelboxErrorCode;
  if (status === 404) return "NOT_FOUND";
  if (status === 422 || status === 400) return "INVALID_ARGUMENT";
  if (status >= 500) return "SANDBOX_UNAVAILABLE";
  return "UNKNOWN";
}

/**
 * Concrete HTTPS client for the Sandbox API.
 *
 * The bearer token is held in memory and sent only as an `Authorization` header
 * — never placed in a URL, and never logged (this class logs nothing). TLS is
 * validated by Node/Bun against `NODE_EXTRA_CA_CERTS`, which the deployment sets
 * before the process starts; the client does not disable verification.
 */
export class PixelboxSandboxClient implements SandboxApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Build a client from the environment contract: `MYCIP_SANDBOX_URL` and the
   * token read from `MYCIP_SANDBOX_TOKEN_FILE`. The token comes from a file, not
   * an env var, so it never lands in the process environment or a crash dump.
   */
  static fromEnv(read: (path: string) => string): PixelboxSandboxClient {
    const baseUrl = process.env.MYCIP_SANDBOX_URL;
    const tokenFile = process.env.MYCIP_SANDBOX_TOKEN_FILE;
    if (!baseUrl) throw new Error("MYCIP_SANDBOX_URL is not set");
    if (!tokenFile) throw new Error("MYCIP_SANDBOX_TOKEN_FILE is not set");
    return new PixelboxSandboxClient({ baseUrl, token: read(tokenFile).trim() });
  }

  private async request(
    method: string,
    path: string,
    options: { body?: string | Uint8Array; contentType?: string; signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    if (options.contentType) headers.set("content-type", options.contentType);
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body,
      signal: options.signal,
    });
    if (!response.ok) {
      let code: string | undefined;
      let detail: string | undefined;
      try {
        const problem = (await response.clone().json()) as { code?: string; detail?: string; title?: string };
        code = problem.code;
        detail = problem.detail ?? problem.title;
      } catch {
        // A non-JSON error body (or empty) leaves classification to the status.
      }
      throw new PixelboxError(classify(response.status, code), detail ?? `HTTP ${response.status}`, response.status);
    }
    return response;
  }

  private query(path: string): string {
    return `path=${encodeURIComponent(path)}`;
  }

  private toInfo(body: unknown): SandboxInfo {
    const b = (body ?? {}) as { sandbox_id?: string; id?: string; state?: string; status?: { state?: string } };
    return {
      sandboxId: (b.sandbox_id ?? b.id)!,
      state: (b.status?.state ?? b.state ?? "created") as SandboxState,
    };
  }

  async create(options: CreateOptions = {}): Promise<SandboxInfo> {
    const response = await this.request("POST", "/v1/sandboxes", {
      body: JSON.stringify(options),
      contentType: "application/json",
      idempotencyKey: crypto.randomUUID(),
    });
    return this.toInfo(await response.json());
  }

  async get(sandboxId: string): Promise<SandboxInfo> {
    const response = await this.request("GET", `/v1/sandboxes/${sandboxId}`);
    return this.toInfo(await response.json());
  }

  async delete(sandboxId: string): Promise<void> {
    await this.request("DELETE", `/v1/sandboxes/${sandboxId}`);
  }

  async execute(sandboxId: string, req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    const response = await this.request("POST", `/v1/sandboxes/${sandboxId}/execute`, {
      body: JSON.stringify({
        command: req.command,
        cwd: req.cwd,
        env: req.env,
        timeout_seconds: req.timeoutSeconds,
        max_output_bytes: req.maxOutputBytes,
      }),
      contentType: "application/json",
      signal,
    });
    const body = (await response.json()) as {
      stdout?: string;
      stderr?: string;
      exit_code?: number;
      timed_out?: boolean;
    };
    return {
      stdout: body.stdout ?? "",
      stderr: body.stderr ?? "",
      exitCode: body.exit_code ?? -1,
      timedOut: body.timed_out ?? false,
    };
  }

  async readBytes(sandboxId: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request("GET", `/v1/sandboxes/${sandboxId}/files/content?${this.query(path)}`, {
      signal,
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeBytes(sandboxId: string, path: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", `/v1/sandboxes/${sandboxId}/files/content?${this.query(path)}`, {
      body: content,
      contentType: "application/octet-stream",
      signal,
    });
  }

  async stat(sandboxId: string, path: string, signal?: AbortSignal): Promise<StatInfo | null> {
    let response: Response;
    try {
      response = await this.request("GET", `/v1/sandboxes/${sandboxId}/files/stat?${this.query(path)}`, { signal });
    } catch (e) {
      if (e instanceof PixelboxError && e.code === "NOT_FOUND") return null;
      throw e;
    }
    const body = (await response.json()) as { type?: string; size?: number; mtime_ms?: number };
    return {
      kind: (body.type ?? "file") as PixelboxFileKind,
      size: body.size ?? 0,
      mtimeMs: body.mtime_ms ?? 0,
    };
  }

  async list(sandboxId: string, path: string, signal?: AbortSignal): Promise<ListEntry[]> {
    const response = await this.request("GET", `/v1/sandboxes/${sandboxId}/files/list?${this.query(path)}`, {
      signal,
    });
    const entries = (await response.json()) as Array<{
      name?: string;
      path?: string;
      type?: string;
      size?: number;
      mtime_ms?: number;
    }>;
    return entries.map((entry) => ({
      name: entry.name ?? "",
      path: entry.path ?? "",
      kind: (entry.type ?? "file") as PixelboxFileKind,
      size: entry.size ?? 0,
      mtimeMs: entry.mtime_ms ?? 0,
    }));
  }

  async createDir(sandboxId: string, path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/v1/sandboxes/${sandboxId}/files/directory?${this.query(path)}`, {
      body: JSON.stringify({ recursive }),
      contentType: "application/json",
      signal,
    });
  }

  async remove(
    sandboxId: string,
    path: string,
    options: { recursive?: boolean; force?: boolean },
    signal?: AbortSignal,
  ): Promise<void> {
    const params = new URLSearchParams({ path });
    if (options.recursive) params.set("recursive", "true");
    if (options.force) params.set("force", "true");
    await this.request("DELETE", `/v1/sandboxes/${sandboxId}/files?${params.toString()}`, { signal });
  }
}
