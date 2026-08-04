import { Hono } from "hono";
import * as workspaceController from "../controllers/workspace.controller";

export const workspaceRoutes = new Hono();

workspaceRoutes.get("/files", workspaceController.index);
// Wildcard: workspace paths are nested, so ":id" would only match one segment.
workspaceRoutes.get("/files/*", workspaceController.show);
