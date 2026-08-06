import { Hono } from "hono";
import * as mcpController from "../controllers/mcp.controller";

export const mcpRoutes = new Hono();

mcpRoutes.get("/", mcpController.index);
mcpRoutes.post("/", mcpController.create);
mcpRoutes.post("/:id/refresh", mcpController.refresh);
mcpRoutes.patch("/:id", mcpController.update);
mcpRoutes.delete("/:id", mcpController.destroy);
