import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";
import type { Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import nodePath from "node:path";
import { execInContainer } from "./docker";

/**
 * The agent's world, relocated into a container.
 *
 * Shell commands run in the container. Filesystem operations are inherited from
 * NodeExecutionEnv and answered by the host, which is equivalent *only* for paths
 * inside the bind-mounted workspace — one path means the same file on both sides
 * there. Outside it the host would answer with host files, so every path is
 * confined to the workspace first. Change the mount and this breaks.
 *
 * Inheriting rather than delegating also keeps pi's own narrower method
 * signatures intact — several take fewer arguments than the `ExecutionEnv`
 * interface allows, which hand-written forwarding gets wrong.
 *
 * Swapping in a hosted backend (E2B, Fly) means one more class against the same
 * interface; nothing else in the app needs to know.
 */
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
      // pi measures timeouts in seconds; the docker layer in milliseconds.
      timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
      signal: options.abortSignal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });

    switch (outcome.kind) {
      case "ok":
        // A non-zero exit is a result the agent should read and react to, not a
        // failure to run. Only the cases below stopped the command executing.
        return ok(outcome.result);
      case "timeout":
        return err(new ExecutionError("timeout", `Command timed out: ${command}`));
      case "aborted":
        return err(new ExecutionError("aborted", `Command aborted: ${command}`));
      case "spawn_error":
        return err(new ExecutionError("spawn_error", outcome.message));
    }
  }

  // ---- filesystem confinement -------------------------------------------
  //
  // The inherited filesystem operates on the host. That is only equivalent to
  // the container for paths inside the bind-mounted workspace; outside it, the
  // host answers with host files. Every path is therefore checked against the
  // workspace before the inherited implementation sees it.

  /**
   * Reject anything resolving outside the workspace.
   *
   * Typed as the failure arm alone so it unions cleanly with each method's own
   * success type — a full `Result` here would widen every return value.
   */
  private guard(path: string): { ok: false; error: FileError } | null {
    const resolved = nodePath.resolve(this.cwd, path);
    const relative = nodePath.relative(this.cwd, resolved);
    const inside = relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
    if (inside) return null;
    return {
      ok: false,
      error: new FileError(
        "permission_denied",
        `Path is outside the sandbox workspace (${this.cwd}). Only files inside the workspace are reachable.`,
        resolved,
      ),
    };
  }

  override async readTextFile(path: string, abortSignal?: AbortSignal) {
    return this.guard(path) ?? super.readTextFile(path, abortSignal);
  }

  override async readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }) {
    return this.guard(path) ?? super.readTextLines(path, options);
  }

  override async readBinaryFile(path: string, abortSignal?: AbortSignal) {
    return this.guard(path) ?? super.readBinaryFile(path, abortSignal);
  }

  override async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    return this.guard(path) ?? super.writeFile(path, content, abortSignal);
  }

  override async appendFile(path: string, content: string | Uint8Array) {
    return this.guard(path) ?? super.appendFile(path, content);
  }

  override async fileInfo(path: string) {
    return this.guard(path) ?? super.fileInfo(path);
  }

  override async listDir(path: string, abortSignal?: AbortSignal) {
    return this.guard(path) ?? super.listDir(path, abortSignal);
  }

  override async exists(path: string) {
    return this.guard(path) ?? super.exists(path);
  }

  override async canonicalPath(path: string) {
    return this.guard(path) ?? super.canonicalPath(path);
  }

  override async createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
    return this.guard(path) ?? super.createDir(path, options);
  }

  override async remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }) {
    return this.guard(path) ?? super.remove(path, options);
  }
}
