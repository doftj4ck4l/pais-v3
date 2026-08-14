import { Hono } from "hono";
import * as mcpController from "../controllers/mcp.controller";

export const mcpRoutes = new Hono();

mcpRoutes.get("/", mcpController.index);
// Both before "/:id" patterns would matter if a GET or POST on an id existed;
// they are literal segments either way, and keeping them here says so.
mcpRoutes.get("/importable", mcpController.importable);
mcpRoutes.post("/import", mcpController.importServer);
mcpRoutes.post("/", mcpController.create);
mcpRoutes.post("/:id/refresh", mcpController.refresh);
mcpRoutes.patch("/:id", mcpController.update);
mcpRoutes.delete("/:id", mcpController.destroy);
