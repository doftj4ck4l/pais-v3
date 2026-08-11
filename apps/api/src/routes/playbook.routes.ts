import { Hono } from "hono";
import * as playbookController from "../controllers/playbook.controller";

export const playbookRoutes = new Hono();

playbookRoutes.get("/", playbookController.index);
playbookRoutes.delete("/:id", playbookController.destroy);
