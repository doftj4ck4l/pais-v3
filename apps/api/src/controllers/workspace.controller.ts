import type { Context } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { list, resolve } from "../repositories/workspace.repository";
import { env } from "../config/env";

const userIdOf = (c: Context) => c.req.query("userId") ?? env.defaultUserId;

/** GET /api/workspace/files — what the agent has produced, newest first. */
export async function index(c: Context) {
  return c.json({ files: await list(userIdOf(c)) });
}

/**
 * GET /api/workspace/files/* — download one file.
 *
 * Always served as an attachment. These bytes were written by an agent, so
 * rendering an .html or .svg inline would execute attacker-influenced content
 * on the console's own origin.
 */
export async function show(c: Context) {
  const requested = c.req.path.split("/api/workspace/files/")[1] ?? "";
  const decoded = safeDecode(requested);
  if (decoded === null) return c.json({ error: "File not found" }, 404);

  const found = await resolve(userIdOf(c), decoded);
  // Rejected and missing are one response: distinguishing them would let a
  // caller map the host's filesystem.
  if (!found.ok) return c.json({ error: "File not found" }, 404);

  const body = await fs.readFile(found.absolutePath).catch(() => null);
  if (!body) return c.json({ error: "File not found" }, 404);

  return c.body(body as unknown as ArrayBuffer, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${quoted(path.basename(found.absolutePath))}"`,
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
  });
}

/** A malformed percent-encoding is a rejected path, not a 500. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Strip what would break out of the quoted filename in the header. */
function quoted(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}
