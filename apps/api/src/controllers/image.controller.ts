import type { Context } from "hono";
import { imageStore } from "../repositories/image.repository";
import { getObject, deleteObject } from "../services/media.service";
import { env } from "../config/env";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { currentUserId } from "../middleware/auth";

/** Same ownership check every other controller goes through. */
const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/** GET /api/images — a workspace's generated images, newest first. */
export async function index(c: Context) {
  const images = await imageStore.list(await workspaceIdOf(c));
  return c.json({ images });
}

/**
 * GET /api/images/:id — the bytes.
 *
 * Served by the API rather than handed out as a presigned URL: the link is
 * written into a chat transcript that outlives any expiry, and RustFS stays
 * unpublished behind the compose network this way.
 */
export async function show(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "no such image" }, 404);

  const row = await imageStore.get(id);
  if (!row) return c.json({ error: "no such image" }, 404);

  let bytes: Uint8Array | null;
  try {
    bytes = await getObject(row.storageKey);
  } catch (e) {
    return c.json({ error: `object storage unavailable: ${(e as Error).message}` }, 502);
  }
  if (!bytes) return c.json({ error: "image row exists but its object is gone" }, 404);

  // A plain Response rather than c.body(): Hono's body overloads do not accept
  // a Uint8Array, and this is binary, not one of its text/JSON shapes.
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(bytes.byteLength),
      // Content is immutable — the id names one set of bytes forever.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/** DELETE /api/images/:id — drop the row, then the object. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "no such image" }, 404);

  const row = await imageStore.remove(await workspaceIdOf(c), id);
  if (!row) return c.json({ error: "no such image" }, 404);
  // Best effort: the row is already gone, so a storage hiccup must not turn a
  // successful delete into a 500. It leaves an orphaned object, not a bad link.
  await deleteObject(row.storageKey).catch(() => {});
  return c.json({ ok: true });
}
