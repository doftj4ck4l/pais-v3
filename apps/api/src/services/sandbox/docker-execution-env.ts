import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ExecutionError, err, ok } from "@earendil-works/pi-agent-core";
import type { Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import { execInContainer } from "./docker";

/**
 * The agent's world, relocated into a container.
 *
 * This *is* a NodeExecutionEnv for every filesystem operation, and overrides
 * only the shell. That is sound because the workspace is bind-mounted at the
 * same absolute path on both sides: one path means the same file whichever half
 * answers, so the agent never sees a seam. Change the mount and this breaks.
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
}
