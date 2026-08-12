import type { Context } from "hono";
import { imageStore } from "../repositories/image.repository";
import { getObject, deleteObject } from "../services/media/media.service";
import { storeUploadedImage } from "../services/media/upload.service";
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
 * POST /api/images — attach an image the user pasted into the chat.
 *
 * Multipart, same as document upload, because that is what a browser produces
 * from a clipboard item without the caller base64-ing a megabyte into JSON.
 *
 * The response is what the composer needs to show a thumbnail and what the
 * chat request needs to reference: an id and the URL that serves it.
 */
export async function create(c: Context) {
  const workspaceId = await workspaceIdOf(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a multipart/form-data body" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file supplied under the 'file' field" }, 400);
  }

  const result = await storeUploadedImage({
    workspaceId,
    conversationId: (form.get("conversationId") as string | null) || null,
    bytes: new Uint8Array(await file.arrayBuffer()),
    contentType: file.type,
    name: file.name,
  });

  // 400 rather than 500: every failure this returns is about the file the
  // caller sent — wrong type, empty, or too big.
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result, 201);
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
