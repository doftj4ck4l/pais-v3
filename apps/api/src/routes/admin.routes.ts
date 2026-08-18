import { Hono } from "hono";
import * as adminController from "../controllers/admin.controller";
import { requireSuperAdmin } from "../middleware/super-admin";

export const adminRoutes = new Hono();

adminRoutes.use("*", requireSuperAdmin);
adminRoutes.get("/analytics", adminController.analytics);
adminRoutes.get("/users", adminController.listUsers);
adminRoutes.get("/runs", adminController.listRuns);
adminRoutes.get("/runs/:id", adminController.getRun);
