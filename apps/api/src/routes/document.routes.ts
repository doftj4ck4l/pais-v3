import { Hono } from "hono";
import * as documentController from "../controllers/document.controller";

export const documentRoutes = new Hono();

documentRoutes.get("/", documentController.index);
documentRoutes.post("/", documentController.create);
// Registered before "/:id" so the literal path is not captured as an id.
documentRoutes.get("/search", documentController.search);
documentRoutes.delete("/:id", documentController.destroy);
