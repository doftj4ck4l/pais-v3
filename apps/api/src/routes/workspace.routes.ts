import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as workspaceController from "../controllers/workspace.controller";
import { MAX_DATA_FILE_BYTES } from "../services/media/workspace-upload";

export const workspaceRoutes = new Hono();

workspaceRoutes.get("/files", workspaceController.index);
workspaceRoutes.post(
  "/files",
  bodyLimit({
    maxSize: MAX_DATA_FILE_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "The attached file is over the 25MB limit." }, 413),
  }),
  workspaceController.create,
);
// Wildcard: workspace paths are nested, so ":id" would only match one segment.
workspaceRoutes.get("/files/*", workspaceController.show);
