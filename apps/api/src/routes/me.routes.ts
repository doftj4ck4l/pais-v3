import { Hono } from "hono";
import * as me from "../controllers/me.controller";

export const meRoutes = new Hono();

meRoutes.get("/", me.show);
