import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { putObject } from "./media.service";
import { imageStore, type ImageStore } from "../../repositories/image.repository";

/**
 * An image the user pasted into the chat.
 *
 * Stored exactly where a generated one goes, because the thing that has to
 * happen next is identical: the agent reaches it through `/api/images/<id>`
 * and `read_image` resolves that. The only difference is `source`, and that
 * `model` and `cost_micros` mean nothing here.
 *
 * The bytes never enter the transcript. A pasted screenshot is routinely a
 * megabyte, and the transcript is replayed to the model on every subsequent
 * turn — the same reasoning that keeps generated images out of it.
 */

/**
 * What the browser is allowed to paste.
 *
 * An allowlist rather than a `image/*` check, and SVG is deliberately absent:
 * SVG is a document that can carry script, and these bytes are served back
 * from the console's own origin.
 */
export const UPLOADABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type UploadResult =
  | { ok: true; id: string; url: string; contentType: string; bytes: number; name: string }
  | { ok: false; error: string };

const extensionFor = (contentType: string): string => {
  const subtype = contentType.split("/")[1]?.split("+")[0] ?? "bin";
  return subtype === "jpeg" ? "jpg" : subtype;
};

export async function storeUploadedImage(
  input: {
    workspaceId: string;
    conversationId?: string | null;
    bytes: Uint8Array;
    contentType: string;
    /** The browser's filename, kept only as a human label. */
    name?: string;
    /**
     * How the bytes got here. Defaults to a paste from the composer;
     * `share_file` passes "shared" so a file the agent produced is not counted
     * as something the user sent.
     */
    source?: "uploaded" | "shared";
  },
  store: ImageStore = imageStore,
  putImpl: typeof putObject = putObject,
): Promise<UploadResult> {
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  if (!UPLOADABLE.has(contentType)) {
    return {
      ok: false,
      error: `${contentType || "that file"} cannot be attached — use ${[...UPLOADABLE].join(", ")}`,
    };
  }
  if (input.bytes.byteLength === 0) return { ok: false, error: "the file is empty" };
  if (input.bytes.byteLength > env.visionMaxBytes) {
    return {
      ok: false,
      error:
        `image is ${Math.round(input.bytes.byteLength / 1_000_000)}MB, over the ` +
        `${Math.round(env.visionMaxBytes / 1_000_000)}MB limit`,
    };
  }

  // Same id shape as a generated image: `read_image` resolves a bare one, and
  // the serving route takes it straight from the path.
  const id = crypto.randomUUID();
  const key = `${input.workspaceId}/${id}.${extensionFor(contentType)}`;

  try {
    await putImpl(key, input.bytes, contentType);
  } catch (e: any) {
    logger.warn("upload.store_failed", { workspaceId: input.workspaceId, message: e?.message });
    return { ok: false, error: `could not store the image: ${e?.message ?? String(e)}` };
  }

  // The filename is a label, not a path — it is never used to read anything
  // back, so it only has to be safe to display.
  const name = (input.name ?? "pasted image").replace(/[\r\n]/g, " ").slice(0, 120);

  await store.save({
    id,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId ?? null,
    prompt: name,
    model: "",
    storageKey: key,
    contentType,
    bytes: input.bytes.byteLength,
    costMicros: null,
    source: input.source ?? "uploaded",
  });

  logger.info("upload.stored", {
    workspaceId: input.workspaceId,
    id,
    bytes: input.bytes.byteLength,
    contentType,
  });

  return { ok: true, id, url: `/api/images/${id}`, contentType, bytes: input.bytes.byteLength, name };
}

/**
 * The line appended to a user message that carried attachments.
 *
 * Text in the message rather than a field beside it, for three reasons that all
 * point the same way: the model sees it without any change to `pi.service`, it
 * survives into the stored transcript so turn five still knows what turn one
 * was shown, and the console can find the URLs again to draw thumbnails.
 *
 * Ids the workspace does not own are dropped silently. They cannot be read
 * anyway — `read_image` checks ownership again — and naming them back to the
 * caller would confirm that an id exists somewhere else.
 */
export async function describeAttachments(
  workspaceId: string,
  imageIds: string[],
  store: ImageStore = imageStore,
): Promise<string> {
  const owned: string[] = [];
  for (const id of imageIds.slice(0, MAX_ATTACHMENTS)) {
    const row = await store.get(id);
    if (row && row.workspaceId === workspaceId) owned.push(row.id);
  }
  if (!owned.length) return "";

  const list = owned.map((id) => `/api/images/${id}`).join(", ");
  const noun = owned.length === 1 ? "an image" : `${owned.length} images`;
  return (
    `\n\n[The user attached ${noun} to this message: ${list}. ` +
    `You cannot see ${owned.length === 1 ? "it" : "them"} directly — call read_image with ` +
    `${owned.length === 1 ? "that source" : "each source"} and a specific question to find out ` +
    `what ${owned.length === 1 ? "it shows" : "they show"}.]`
  );
}

/**
 * Attachments honoured per message.
 *
 * Each one is a separate vision call the agent may make, and the cap is what
 * stops a paste of thirty screenshots from becoming thirty model requests.
 */
export const MAX_ATTACHMENTS = 6;
