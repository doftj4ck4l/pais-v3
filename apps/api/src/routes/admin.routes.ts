import { Hono } from "hono";
import * as adminController from "../controllers/admin.controller";

export const adminRoutes = new Hono();

adminRoutes.get("/runs", adminController.listRuns);
adminRoutes.get("/runs/:id", adminController.getRun);
