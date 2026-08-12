import { Hono } from "hono";
import * as imageController from "../controllers/image.controller";

export const imageRoutes = new Hono();

imageRoutes.get("/", imageController.index);
// Paste-to-attach. Uploads land in the same bucket and table as generated
// images, so `read_image` reaches them by the same /api/images/<id> URL.
imageRoutes.post("/", imageController.create);
imageRoutes.get("/:id", imageController.show);
imageRoutes.delete("/:id", imageController.destroy);
