/**
 * Does a workspace outlive its container?
 *
 * This is the whole feasibility question behind sandboxed agents, isolated from
 * the app. Run it before trusting any of the sandbox code:
 *
 *   bun scripts/sandbox-persistence-check.ts
 *
 * The third cycle is the point. E2B's issue #884 was a bug where files survived
 * the first resume and vanished on the second, so a single round trip proves
 * nothing.
 */
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

/** Mount the workspace at its own host path so both sides share one namespace. */
async function startContainer(): Promise<string> {
  const r = await sh(["run", "-d", "-v", `${WS}:${WS}`, "-w", WS, IMAGE, "sleep", "infinity"]);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.out}`);
  return r.out;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

const pull = await sh(["images", "-q", IMAGE]);
if (!pull.out) {
  console.log(`pulling ${IMAGE} (first run only)…`);
  await sh(["pull", IMAGE]);
}

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

console.log("cycle 1: container creates a file");
let id = await startContainer();
await sh(["exec", id, "sh", "-lc", `echo one > ${WS}/note.txt`]);
await sh(["rm", "-f", id]);
assert(fs.readFileSync(path.join(WS, "note.txt"), "utf8").trim() === "one", "file survived container removal");

console.log("cycle 2: a new container reads and appends");
id = await startContainer();
const first = await sh(["exec", id, "cat", `${WS}/note.txt`]);
assert(first.out === "one", "new container reads the old file");
await sh(["exec", id, "sh", "-lc", `echo two >> ${WS}/note.txt`]);
await sh(["rm", "-f", id]);

console.log("cycle 3: the case that broke E2B — a second round trip");
id = await startContainer();
const second = await sh(["exec", id, "cat", `${WS}/note.txt`]);
assert(second.out === "one\ntwo", "the append survived the SECOND cycle");
await sh(["rm", "-f", id]);

console.log("\nPERSISTENCE PROVEN");
