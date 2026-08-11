import type { Context } from "hono";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { playbookStore } from "../repositories/playbook.repository";
import { isDemoted, scoreOf } from "../services/playbook/delta";
import { selectForPrompt } from "../services/playbook/prompt";
import { currentUserId } from "../middleware/auth";

/**
 * Read and delete over one workspace's playbook.
 *
 * There is no create and no update. A bullet gets in by being learned, and the
 * only manual control is removal — which keeps the question "where did this
 * come from" answerable, and keeps this endpoint from becoming a second way to
 * write to a store whose whole point is that it writes itself.
 */

const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/** GET /api/playbook — every bullet, with whether the model is currently shown it. */
export async function index(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const bullets = await playbookStore.list(workspaceId);

  // Which bullets survive selection is not derivable from a single row — it
  // depends on the char cap and on every other bullet — so it is computed once
  // here rather than reimplemented in the browser.
  const inPrompt = new Set(selectForPrompt(bullets).map((b) => b.id));

  return c.json({
    bullets: bullets
      .map((b) => ({
        ...b,
        score: scoreOf(b),
        demoted: isDemoted(b),
        inPrompt: inPrompt.has(b.id),
      }))
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt),
  });
}

/** DELETE /api/playbook/:id */
export async function destroy(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const removed = await playbookStore.remove(workspaceId, c.req.param("id") ?? "");
  if (!removed) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
}
