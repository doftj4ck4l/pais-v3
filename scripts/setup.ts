/**
 * One-command setup: `bun run setup`
 *
 * Everything a fresh clone needs that git cannot carry — dependencies, the
 * sandbox image (built locally, not pullable), and a .env to fill in.
 *
 * Idempotent: safe to re-run, and skips work that is already done. It reports
 * what it could not do rather than failing silently, because a half-set-up
 * checkout that looks fine is worse than one that says what is missing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = path.join(ROOT, "apps", "api");
const IMAGE = process.env.SANDBOX_IMAGE ?? "salurai-sandbox:1";

const problems: string[] = [];
const notes: string[] = [];

function run(command: string, args: string[], cwd = ROOT): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

function capture(command: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: -1, out }));
    child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim() }));
  });
}

function step(n: number, total: number, title: string) {
  console.log(`\n\x1b[1m[${n}/${total}] ${title}\x1b[0m`);
}

const TOTAL = 4;

// ---- 1. dependencies --------------------------------------------------------
step(1, TOTAL, "Installing dependencies");
if ((await run("bun", ["install"])) !== 0) {
  problems.push("bun install failed — fix that first, nothing else will work.");
}

// ---- 2. environment ---------------------------------------------------------
step(2, TOTAL, "Checking apps/api/.env");
const envPath = path.join(API, ".env");
const examplePath = path.join(API, ".env.example");

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log("  created apps/api/.env from .env.example");
  problems.push("apps/api/.env has no API key yet — set CUSTOM_BASE_URL and CUSTOM_API_KEY.");
} else {
  const body = fs.readFileSync(envPath, "utf8");
  const key = body.match(/^CUSTOM_API_KEY=(.*)$/m)?.[1]?.trim();
  if (key) console.log("  CUSTOM_API_KEY is set");
  else problems.push("apps/api/.env exists but CUSTOM_API_KEY is empty — models will show unavailable.");
}

// ---- 3. docker --------------------------------------------------------------
step(3, TOTAL, "Checking Docker");
const daemon = await capture("docker", ["version", "--format", "{{.Server.Version}}"]);
const dockerUp = daemon.code === 0;

if (dockerUp) {
  console.log(`  daemon running (${daemon.out})`);
} else {
  // Not fatal to setup, but the default sandbox backend needs it at run time.
  problems.push(
    "Docker is not reachable. Start Docker Desktop, then re-run `bun run setup` to build the sandbox image.",
  );
}

// ---- 4. sandbox image -------------------------------------------------------
step(4, TOTAL, `Sandbox image (${IMAGE})`);
if (!dockerUp) {
  console.log("  skipped — Docker is not running");
} else {
  const existing = await capture("docker", ["images", "-q", IMAGE]);
  if (existing.out) {
    console.log("  already built");
    notes.push(`Rebuild the image after changing the Dockerfile: \`bun run sandbox:build\``);
  } else {
    console.log("  building — this takes a few minutes the first time");
    const built = await run(
      "docker",
      ["build", "-t", IMAGE, "-f", "sandbox/Dockerfile", "sandbox/"],
      API,
    );
    if (built !== 0) problems.push(`Building ${IMAGE} failed. Run \`bun run sandbox:build\` to see why.`);
  }
}

// ---- report -----------------------------------------------------------------
console.log("");
if (problems.length) {
  console.log("\x1b[33mSetup finished with things to fix:\x1b[0m");
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log("\x1b[32mSetup complete.\x1b[0m");
}
for (const n of notes) console.log(`  note: ${n}`);

console.log("\nStart the app:  \x1b[1mbun run dev\x1b[0m   → http://localhost:5173");

// A missing key or a stopped daemon is a to-do, not a crash; exiting non-zero
// would break `bun run setup && bun run dev` for someone who just needs to
// paste a key.
process.exit(0);
