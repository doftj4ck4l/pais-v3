import fs from "node:fs";
import path from "node:path";
import {
  loadSkills,
  formatSkillsForSystemPrompt,
  type Skill,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { env as appEnv } from "../../config/env";
import { SKILLS_MOUNT } from "../sandbox/docker";
import { logger } from "../../lib/logger";

/** Placeholder a skill's `run` command uses to locate its own directory. */
const SKILL_DIR = "$SKILL_DIR";

let cached: {
  env: ExecutionEnv;
  skills: Skill[];
  commands: Map<string, string>;
  /** Optional per-skill `usage:` line advertising the arguments it expects. */
  usage: Map<string, string>;
} | null = null;

/**
 * Load pi-native SKILL.md skills from apps/api/skills (recursively) using the
 * real pi skills loader. Returns the execution env (for shell) and the skills.
 */
export async function getSkills() {
  if (cached) return cached;
  const skillsDir = appEnv.skillsRoot;
  const env = new NodeExecutionEnv({ cwd: skillsDir });
  const { skills, diagnostics } = await loadSkills(env, skillsDir);
  for (const d of diagnostics) logger.warn("skill.load", { code: d.code, message: d.message, path: d.path });

  const commands = new Map<string, string>();
  const usage = new Map<string, string>();
  for (const skill of skills) {
    commands.set(skill.name, runCommandFor(skill, skillsDir));
    const u = readFrontmatterField(skill.filePath, "usage");
    if (u) usage.set(skill.name, u);
  }

  cached = { env, skills, commands, usage };
  logger.info("skills.ready", { count: skills.length, names: skills.map((s) => s.name) });
  return cached;
}

/**
 * The command that launches a skill, with `$SKILL_DIR` already resolved to the
 * skill's location inside the container.
 *
 * pi's `Skill` type carries no custom frontmatter, so `run:` is read from the
 * file directly. Skills without it keep the original `node <name>.cjs`
 * convention, so the existing web-fetch skill is unaffected.
 */
function runCommandFor(skill: Skill, skillsDir: string): string {
  const template = readFrontmatterField(skill.filePath, "run") ?? `node ${SKILL_DIR}/${skill.name}.cjs`;
  // Skills are mounted at a fixed path, so the container-side directory is the
  // skill's location relative to the skills root — never the host path.
  const relative = path.relative(skillsDir, path.dirname(skill.filePath));
  const containerDir = path.posix.join(SKILLS_MOUNT, ...relative.split(path.sep).filter(Boolean));
  return template.split(SKILL_DIR).join(containerDir);
}

/**
 * Read one single-line field out of a SKILL.md frontmatter block.
 *
 * pi's `Skill` type carries no custom frontmatter, so fields like `run:` and
 * `usage:` are read from the file directly. A missing field returns null and
 * the caller keeps its default.
 */
function readFrontmatterField(filePath: string, field: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const match = frontmatter[1]!.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"));
  return match ? match[1]! : null;
}

/** XML-formatted skill listing injected into the system prompt (agentskills.io spec). */
export async function skillsBlock() {
  const { skills, usage } = await getSkills();
  // pi formats each skill with the host-side SKILL.md path. Sandboxes only see
  // the read-only /skills mount, so exposing that path made agents try to cat
  // /home/.../apps/api/skills/docx/SKILL.md and fail. Rewrite every advertised
  // location to the path that bash/read can actually open in the container.
  let block = containerSkillPromptLocations(
    formatSkillsForSystemPrompt(skills),
    skills,
    appEnv.skillsRoot,
  );
  // The external formatter emits name + description + location only. Append the
  // declared arguments so the model sees a skill's required args before calling
  // it, instead of learning them from a failed first call (measured: docx
  // failed once on a missing "path" before the model added it).
  const documented = skills.filter((s) => usage.has(s.name));
  if (documented.length) {
    block +=
      "\n\nSkill arguments (pass as the call_skill \"query\"):\n" +
      documented.map((s) => `- ${s.name}: ${usage.get(s.name)}`).join("\n");
  }
  return block;
}

export function containerSkillPromptLocations(
  block: string,
  skills: Array<Pick<Skill, "filePath">>,
  skillsDir: string,
): string {
  let output = block;
  for (const skill of skills) {
    const relative = path.relative(skillsDir, skill.filePath);
    const containerPath = path.posix.join(
      SKILLS_MOUNT,
      ...relative.split(path.sep).filter(Boolean),
    );
    output = output.split(skill.filePath).join(containerPath);
  }
  return output;
}

/** Single-quote a value for `sh -lc`, so an argument can never become syntax. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Run a loaded skill inside the agent's execution environment.
 *
 * Skills execute wherever the other tools execute — in the sandbox container —
 * rather than on the API host. A skill is arbitrary code and is the extension
 * point for third-party code, so running it on the host would hand it the
 * server's user, filesystem and environment, including the gateway API key.
 *
 * Output is written relative to the environment's cwd, which is the user's
 * workspace, so a generated file lands where the agent and the download
 * endpoint can both reach it.
 */
export async function invokeSkill(
  name: string,
  arg: string,
  execEnv: ExecutionEnv,
): Promise<string> {
  const { skills, commands } = await getSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    return `error: unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(", ")}`;
  }

  // Refuse rather than fall back to the host. A silent fallback is exactly the
  // exposure this indirection exists to remove.
  if (appEnv.sandboxBackend !== "docker") {
    return (
      `error: skills run inside the sandbox, and SANDBOX_BACKEND is ` +
      `"${appEnv.sandboxBackend}". Set SANDBOX_BACKEND=docker (with Docker running) to use skills.`
    );
  }

  const command = `${commands.get(name)!}${arg ? ` ${shellQuote(arg)}` : ""}`;
  const outcome = await execEnv.exec(command, { timeout: 120 });

  if (!outcome.ok) {
    return `error running skill "${name}": ${outcome.error.message}`;
  }

  const { stdout, stderr, exitCode } = outcome.value;
  if (exitCode !== 0) {
    // Hand stderr back so the model can correct its own arguments.
    return `skill "${name}" exited ${exitCode}\n${stderr.trim() || stdout.trim() || "(no output)"}`;
  }
  return (stdout.trim() || "(no output)") + (stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : "");
}
