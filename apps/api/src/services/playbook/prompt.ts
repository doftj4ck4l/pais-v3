import { isDemoted, scoreOf } from "./delta";
import type { Bullet } from "./types";

/**
 * The playbook as a system-prompt block, and as the reflector's view of what
 * already exists.
 *
 * These are two renderings of one list and they differ in one way that matters:
 * the reflector's includes bullet ids, because it has to name them to update
 * them, and the model's does not, because an id in the prompt is 4 tokens per
 * bullet that buys the run nothing.
 */

/**
 * Hard ceiling on the injected block.
 *
 * Chosen against the thing this competes with: MCP tool schemas, measured at
 * 36,512 tokens for one server. ~6k characters is roughly 1.5k tokens — under
 * 5% of that floor, and small enough that a workspace with a large playbook
 * still pays less for all of it than for one unused tool schema. When the
 * playbook outgrows this, the lowest-scoring bullets fall out of the *prompt*
 * and stay in the database; nothing is deleted to fit.
 */
export const PLAYBOOK_CHAR_CAP = 6000;

const HEADINGS: Record<string, string> = {
  fact: "What you know about this workspace",
  route: "How to do things here",
  pitfall: "Dead ends — do not repeat these",
};

/** Bullets eligible for the prompt, best first. */
export function selectForPrompt(bullets: Bullet[], cap = PLAYBOOK_CHAR_CAP): Bullet[] {
  const ranked = bullets
    .filter((b) => !isDemoted(b))
    .sort((a, b) => scoreOf(b) - scoreOf(a) || b.updatedAt - a.updatedAt);

  const kept: Bullet[] = [];
  let used = 0;
  for (const bullet of ranked) {
    const cost = bullet.content.length + 3; // "- " and a newline
    if (used + cost > cap) continue; // skip, don't stop: a short bullet may still fit
    kept.push(bullet);
    used += cost;
  }
  return kept;
}

/**
 * The block appended to the system prompt.
 *
 * Empty string when there is nothing learned yet, so a fresh workspace carries
 * no heading promising knowledge it does not have — a model shown an empty
 * "what you know" section will fill it in from imagination.
 */
export function renderPlaybook(bullets: Bullet[], cap = PLAYBOOK_CHAR_CAP): string {
  const selected = selectForPrompt(bullets, cap);
  if (!selected.length) return "";

  const sections: string[] = [];
  for (const kind of ["fact", "route", "pitfall"] as const) {
    const lines = selected.filter((b) => b.kind === kind);
    if (!lines.length) continue;
    sections.push(`${HEADINGS[kind]}:\n${lines.map((b) => `- ${b.content}`).join("\n")}`);
  }

  return `\n\nLearned from earlier runs in this workspace. Trust these over guessing, and over searching for something you have already been told:\n\n${sections.join("\n\n")}`;
}

/** The same list, with ids, for the reflector to update by reference. */
export function renderForReflector(bullets: Bullet[]): string {
  if (!bullets.length) return "The playbook is empty — nothing has been learned yet.";
  return bullets
    .map((b) => `${b.id} [${b.kind}] (helpful ${b.helpful}, harmful ${b.harmful}) ${b.content}`)
    .join("\n");
}
