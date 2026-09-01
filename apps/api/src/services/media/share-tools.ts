import path from "node:path";
import { logger } from "../../lib/logger";
import { mediaConfigured } from "./media.service";
import { UPLOADABLE, storeUploadedImage } from "./upload.service";
import { resolveInWorkspace } from "./vision-tools";
import { readInWorkspace, statInWorkspace } from "./workspace-io";
import { workspaceFileUrl } from "./workspace-url";

export { workspaceFileUrl } from "./workspace-url";

/**
 * `share_file` — turn a file the agent wrote into a URL the user can open.
 *
 * This exists because of a run that drew a picture and then handed the user
 * `/home/temp-dev/pixelspace-workspaces/ws_.../red_panda_library.png`. Every
 * word of that was true and none of it was reachable: the path names a
 * directory inside a container the user has no shell on, so a finished piece of
 * work read as a fabrication. The files were downloadable from the Files page
 * the whole time — nothing had ever told the model that, so it reported the
 * only location it knew.
 *
 * Two destinations, because they are not interchangeable:
 *
 * - **Images go to the media bucket** and come back as `/api/images/<id>`,
 *   which is served with its real content type and so renders inline in the
 *   transcript. That is the whole point for a picture: the user should see it
 *   in the answer, not download an attachment and open it themselves.
 * - **Everything else gets its workspace download URL.** `/api/workspace/files/*`
 *   already serves those bytes, and the workspace directory outlives the
 *   container — `sandboxService` reaps containers and never touches
 *   directories. Copying a spreadsheet into the bucket would buy a second copy
 *   and a second thing to keep in step, not durability.
 *
 * SVG is an image everywhere except here. It is a document that can carry
 * script and the bucket route serves from the console's own origin, so it takes
 * the file branch, which serves every extension as an attachment. Render it to
 * PNG and share that if it needs to be seen.
 */

/** Extension → content type, for the bucket branch. Mirrors `UPLOADABLE`. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const text = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  details: { output: s },
});

export type ShareDeps = {
  /** Whether the bucket is reachable. Injected so a test can drive both branches. */
  configured: typeof mediaConfigured;
  store: typeof storeUploadedImage;
  stat?: typeof statInWorkspace;
  read?: typeof readInWorkspace;
};

export function createShareTools(
  workspaceId: string,
  workspaceDir: string,
  deps: ShareDeps = { configured: mediaConfigured, store: storeUploadedImage },
  /** Stamped on the stored row so the shared picture lands in this session's panel. */
  conversationId?: string,
): any[] {
  return [
    {
      name: "share_file",
      label: "share_file",
      description:
        "Give the user a link to a file you created. Call this for every file you want them " +
        "to have — an image, a document, a spreadsheet, a script — and put the URL it returns " +
        "in your answer. A path in your workspace is not reachable by the user: it names a " +
        "directory inside your container, and quoting one instead of a URL leaves them with " +
        "nothing to open. Images come back as a URL you should embed as markdown " +
        "(![name](url)) so the picture appears in the reply; other files come back as a " +
        "download link to write as a normal markdown link.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "path to the file in your workspace, e.g. 'report.xlsx' or an absolute path",
          },
          name: {
            type: "string",
            description: "optional label for the user, e.g. 'Q3 revenue report'",
          },
        },
        required: ["path"],
      },
      async execute(_id: string, params: any) {
        const source = String(params?.path ?? "").trim();
        if (!source) return text("error: path required");

        // Same boundary as `read_image`, and load-bearing for the same reason:
        // this runs in the API process, where SANDBOX_ROOT is mounted at an
        // identical path, so an unchecked `../..` would publish the API's own
        // secrets at a URL.
        const resolved = resolveInWorkspace(workspaceDir, source);
        if (!resolved) return text(`error: ${source} is outside your workspace`);

        const stat = await (deps.stat ?? statInWorkspace)(workspaceId, resolved);
        if (!stat) return text(`error: ${source} does not exist in your workspace`);
        if (!stat.isFile) return text(`error: ${source} is a directory, not a file`);

        const relative = path.relative(path.resolve(workspaceDir), resolved);
        const label = String(params?.name ?? "").trim() || path.basename(resolved);
        const contentType = IMAGE_TYPES[path.extname(resolved).toLowerCase()] ?? "";

        if (contentType && UPLOADABLE.has(contentType) && deps.configured()) {
          const bytes = await (deps.read ?? readInWorkspace)(workspaceId, resolved);
          if (!bytes) return text(`error: could not read ${source}`);

          const stored = await deps.store({
            workspaceId,
            conversationId,
            bytes,
            contentType,
            name: label,
            source: "shared",
          });
          // Not fatal: the file is still downloadable, and a bucket that is
          // briefly unreachable should cost the user a thumbnail rather than
          // the answer. Fall through to the file branch.
          if (stored.ok) {
            return text(
              `Shared. The user can see it at ${stored.url} — put it in your answer as ` +
                `![${label}](${stored.url}) so the image appears inline.`,
            );
          }
          logger.warn("share.upload_failed", { workspaceId, path: relative, error: stored.error });
        }

        const url = workspaceFileUrl(workspaceId, relative);
        return text(
          `Shared. The user can download it at ${url} — put it in your answer as ` +
            `[${label}](${url}). It also appears on their Files page.`,
        );
      },
    },
  ];
}
