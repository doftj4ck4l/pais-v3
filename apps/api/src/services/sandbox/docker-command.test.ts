import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cancellationWrapper } from "./docker";

/**
 * The wrapper is exercised on the host rather than inside a container.
 *
 * The failure it guards against is bash's own treatment of a background job's
 * stdin, not Docker's, so a real bash is the whole environment it needs — which
 * also keeps this file runnable in CI, where the three Docker suites are
 * excluded by name and could not have caught it. macOS ships no `setsid`, so a
 * stub on PATH stands in for it: the wrapper only needs a process that execs the
 * argv it is handed.
 */
function spawnWrapper(script: string, args: string[], input?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixelspace-wrapper-"));
  try {
    fs.writeFileSync(path.join(dir, "setsid"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    return spawnSync("bash", ["-c", script, "pixelspace-exec", ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the cancellation wrapper keeps the command's stdin readable", () => {
  const pidFile = path.join(os.tmpdir(), "pixelspace-wrapper-read.pid");
  const run = spawnWrapper(cancellationWrapper(pidFile, true), [pidFile, "cat"], "request");
  expect(run.stdout).toBe("request");
});

test("the cancellation wrapper runs a command that takes no stdin", () => {
  const pidFile = path.join(os.tmpdir(), "pixelspace-wrapper-echo.pid");
  const run = spawnWrapper(cancellationWrapper(pidFile, false), [pidFile, "echo", "ok"]);
  expect(run.stdout.trim()).toBe("ok");
});
