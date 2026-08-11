import { Hono } from "hono";
import * as imageController from "../controllers/image.controller";

export const imageRoutes = new Hono();

imageRoutes.get("/", imageController.index);
imageRoutes.get("/:id", imageController.show);
imageRoutes.delete("/:id", imageController.destroy);
