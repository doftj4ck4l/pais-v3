import path from "node:path";
import { env } from "../../config/env";
import { describeImage } from "./vision.service";
import { getObject } from "./media.service";
import { imageStore, type ImageStore } from "../../repositories/image.repository";
import { readInWorkspace } from "./workspace-io";

/**
 * The `read_image` tool, bound to one workspace.
 *
 * Two sources, because there are exactly two places an image the agent cares
 * about actually lives: a file in its own workspace, and an image it generated
 * earlier. The second matters more than it looks — `generate_image` returns a
 * `/api/images/<id>` URL that the chat model has never been able to see, so a
 * run could make a picture and then be unable to answer "is the text spelled
 * right". This closes that loop.
 *
 * Deliberately not a third source: an arbitrary http(s) URL. This tool runs in
 * the API process, so fetching a caller-supplied URL would let any prompt reach
 * anything the API host can reach — the compose network included. Images from
 * the web arrive through the workspace, where the sandbox has already fetched
 * them.
 */

const EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: { output: s } });

const IMAGE_URL_PREFIX = "/api/images/";
/** An id as `image.repository` mints them: `crypto.randomUUID()`, no dots, no slashes. */
const BARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Anything after the URL prefix that could be an id at all. */
const URL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/api/images/<id>` or a bare id → the id. Null when it is a file path.
 *
 * The shapes are checked rather than assumed: ids come from
 * `crypto.randomUUID()`, so an earlier version of this that matched only an
 * `img_` prefix never recognised a single real image — every `/api/images/…`
 * URL fell through to the file branch and failed as "outside your workspace".
 *
 * A bare id must look like a UUID. Loosening that to "any word" would swallow
 * a file called `screenshot`, and answer a missing file with the wrong error.
 */
export function generatedImageId(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed.startsWith(IMAGE_URL_PREFIX)) {
    const id = trimmed.slice(IMAGE_URL_PREFIX.length);
    return URL_ID.test(id) ? id : null;
  }
  return BARE_ID.test(trimmed) ? trimmed : null;
}

/**
 * Resolve a workspace-relative or absolute path, and refuse anything outside.
 *
 * This is the one security decision in the file. `bash` and `read` are confined
 * to the sandbox container; this tool is not — it runs with the API's
 * privileges, and `SANDBOX_ROOT` is bind-mounted into the API at an identical
 * path, so an unchecked `../../..` would read the API's own secrets and post
 * them to a model. Containment is what makes the shared mount safe to use.
 */
export function resolveInWorkspace(workspaceDir: string, source: string): string | null {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, source);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(prefix) ? target : null;
}

export function createVisionTools(
  workspaceId: string,
  workspaceDir: string,
  store: ImageStore = imageStore,
  readWorkspace: typeof readInWorkspace = readInWorkspace,
): any[] {
  return [
    {
      name: "read_image",
      label: "read_image",
      description:
        "Look at an image and answer a question about it. Use this for any image — a screenshot, " +
        "photo, chart, diagram, scan or UI mockup — including images you generated earlier. " +
        "Pass a file path in your workspace, or the /api/images/<id> URL that generate_image " +
        "returned. Ask a specific question ('what is the error message in this screenshot?', " +
        "'transcribe all text', 'what does this chart show?') rather than 'describe it' — the " +
        "question is the only control you have over the answer. " +
        "The image is read by a separate vision model and comes back as text, so you can act on " +
        "the answer even though you cannot see pictures yourself.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "path to an image in your workspace (e.g. 'screenshot.png' or an absolute path), " +
              "or a generated image URL like /api/images/img_abc123",
          },
          question: {
            type: "string",
            description:
              "what you want to know about the image, e.g. 'transcribe every line of text' or " +
              "'which button is highlighted?'",
          },
          model: {
            type: "string",
            description: `optional vision model. Defaults to ${env.visionModel}.`,
          },
        },
        required: ["source", "question"],
      },
      async execute(_id: string, params: any) {
        const source = String(params?.source ?? "").trim();
        const question = String(params?.question ?? "").trim();
        if (!source) return text("error: source required");
        if (!question) return text("error: question required — say what you want to know");

        let bytes: Uint8Array;
        let contentType: string;

        const imageId = generatedImageId(source);
        if (imageId) {
          const row = await store.get(imageId);
          if (!row || row.workspaceId !== workspaceId) {
            return text(`error: no generated image ${imageId} in this workspace`);
          }
          const object = await getObject(row.storageKey);
          if (!object) return text(`error: image ${imageId} is recorded but its bytes are missing`);
          bytes = object;
          contentType = row.contentType;
        } else {
          const resolved = resolveInWorkspace(workspaceDir, source);
          if (!resolved) {
            return text(`error: ${source} is outside your workspace`);
          }
          contentType = EXTENSIONS[path.extname(resolved).toLowerCase()] ?? "";
          if (!contentType) {
            return text(
              `error: ${path.extname(resolved) || source} is not a readable image ` +
                `(supported: ${Object.keys(EXTENSIONS).join(", ")})`,
            );
          }
          const read = await readWorkspace(workspaceId, resolved);
          if (!read) return text(`error: ${source} does not exist in your workspace`);
          bytes = read;
        }

        const result = await describeImage({
          bytes,
          contentType,
          question,
          model: params?.model ? String(params.model) : undefined,
        });

        if (!result.ok) return text(`error: ${result.error}`);
        return text(result.text);
      },
    },
  ];
}
