import { Hono } from "hono";
import * as controller from "../controllers/workspace-registry.controller";

export const workspaceRegistryRoutes = new Hono();

workspaceRegistryRoutes.get("/", controller.index);
workspaceRegistryRoutes.post("/", controller.create);
workspaceRegistryRoutes.patch("/:id", controller.update);
workspaceRegistryRoutes.delete("/:id", controller.destroy);
