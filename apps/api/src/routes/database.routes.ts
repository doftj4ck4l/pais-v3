import { Hono } from "hono";
import * as databaseController from "../controllers/database.controller";

export const databaseRoutes = new Hono();

databaseRoutes.get("/", databaseController.index);
databaseRoutes.post("/", databaseController.create);
databaseRoutes.post("/:id/refresh", databaseController.refresh);
databaseRoutes.delete("/:id", databaseController.destroy);
