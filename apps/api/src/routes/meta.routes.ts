import { Hono } from "hono";
import * as metaController from "../controllers/meta.controller";

export const metaRoutes = new Hono();

metaRoutes.get("/", metaController.show);
