import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadSkills,
  formatSkillsForSystemPrompt,
  type Skill,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { logger } from "../lib/logger";

const execFileP = promisify(execFile);

let cached: { env: ExecutionEnv; skills: Skill[] } | null = null;

/**
 * Load pi-native SKILL.md skills from apps/api/skills (recursively) using the
 * real pi skills loader. Returns the execution env (for shell) and the skills.
 */
export async function getSkills() {
  if (cached) return cached;
  const skillsDir = fileURLToPath(new URL("../skills/", import.meta.url));
  const env = new NodeExecutionEnv({ cwd: skillsDir });
  const { skills, diagnostics } = await loadSkills(env, skillsDir);
  for (const d of diagnostics) logger.warn("skill.load", { code: d.code, message: d.message, path: d.path });
  cached = { env, skills };
  logger.info("skills.ready", { count: skills.length, names: skills.map((s) => s.name) });
  return cached;
}

/** XML-formatted skill listing injected into the system prompt (agentskills.io spec). */
export async function skillsBlock() {
  const { skills } = await getSkills();
  return formatSkillsForSystemPrompt(skills);
}

/** Run a loaded skill's script with the given argument string. Returns output text. */
export async function invokeSkill(name: string, arg: string): Promise<string> {
  const { skills } = await getSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return `error: unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(", ")}`;
  const script = join(dirname(skill.filePath), `${skill.name}.cjs`);
  try {
    const { stdout, stderr } = await execFileP("node", [script, arg || ""], {
      timeout: 15000,
      maxBuffer: 3 * 1024 * 1024,
      cwd: resolve(dirname(skill.filePath)),
    });
    const stderrSuffix = stderr ? `\n[stderr]\n${stderr.trim()}` : "";
    return (stdout || "(no output)") + stderrSuffix;
  } catch (e: any) {
    return `error running skill "${name}": ${e?.message ?? String(e)}`;
  }
}
